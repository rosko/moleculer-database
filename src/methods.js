/*
 * @moleculer/database
 * Copyright (c) 2021 MoleculerJS (https://github.com/moleculerjs/database)
 * MIT Licensed
 */

"use strict";

const Adapters = require("./adapters");
const { Context } = require("moleculer"); // eslint-disable-line no-unused-vars
const { EntityNotFoundError } = require("./errors");
const { MoleculerClientError } = require("moleculer").Errors;
const { Transform } = require("stream");
const _ = require("lodash");

module.exports = function (mixinOpts) {
	const cacheOpts = mixinOpts.cache && mixinOpts.cache.enabled ? mixinOpts.cache : null;

	const cacheColumnName = new Map();

	return {
		/**
		 * Get or create an adapter. Multi-tenant support method.
		 * @param {Context?} ctx
		 */
		async getAdapter(ctx) {
			const [hash, adapterOpts] = await this.getAdapterByContext(ctx, mixinOpts.adapter);
			const item = this.adapters.get(hash);
			if (item) {
				item.touched = Date.now();
				return item.adapter;
			}

			this.logger.debug(`Adapter not found for '${hash}'. Create a new adapter instance...`);
			const adapter = Adapters.resolve(adapterOpts);
			adapter.init(this);
			this.adapters.set(hash, { hash, adapter, touched: Date.now() });
			await this.maintenanceAdapters();
			await this._connect(adapter, hash, adapterOpts);
			this.logger.info(
				`Adapter '${hash}' connected. Number of adapters:`,
				this.adapters.size
			);

			return adapter;
		},

		/**
		 * For multi-tenant support this method generates a cache key
		 * hash value from `ctx`. By default, it returns "default" hash key.
		 * It can be overwritten to implement custom multi-tenant solution.
		 *
		 * @param {Context?} ctx
		 * @param {Object|any?} adapterDef
		 */
		getAdapterByContext(ctx, adapterDef) {
			return ["default", adapterDef];
		},

		async maintenanceAdapters() {
			if (mixinOpts.maximumAdapters == null || mixinOpts.maximumAdapters < 1) return;

			const surplus = this.adapters.size - mixinOpts.maximumAdapters;
			if (surplus > 0) {
				let adapters = Array.from(this.adapters.values());
				adapters.sort((a, b) => a.touched - b.touched);
				const closeable = adapters.slice(0, surplus);
				this.logger.info(
					`Close ${closeable.length} old adapter(s). Limit: ${mixinOpts.maximumAdapters}, Current: ${this.adapters.size}`
				);
				for (const { adapter, hash } of closeable) {
					await this._disconnect(adapter, hash);
				}
			}
		},

		/**
		 * Connect to the DB
		 *
		 * @param {Adapter} adapter
		 * @param {String} hash
		 * @param {Object} adapterOpts
		 */
		_connect(adapter, hash, adapterOpts) {
			return new this.Promise((resolve, reject) => {
				const connecting = async () => {
					try {
						await adapter.connect();
						if (this.$hooks["adapterConnected"])
							await this.$hooks["adapterConnected"](adapter, hash, adapterOpts);
						resolve();
					} catch (err) {
						this.logger.error("Connection error!", err);
						if (mixinOpts.autoReconnect) {
							setTimeout(() => {
								this.logger.warn("Reconnecting...");
								connecting();
							}, 1000);
						} else {
							reject(err);
						}
					}
				};
				connecting();
			});
		},

		/**
		 * Disconnect an adapter
		 *
		 * @param {Adapter} adapter
		 * @param {String} hash
		 */
		async _disconnect(adapter, hash) {
			// Remove from cache
			const item = Array.from(this.adapters.values()).find(item => item.adapter == adapter);
			if (item) {
				this.adapters.delete(item.hash);
			}

			// Close the connection
			if (_.isFunction(adapter.disconnect)) await adapter.disconnect();
			this.logger.info(
				`Adapter '${item ? item.hash : "unknown"}' diconnected. Number of adapters:`,
				this.adapters.size
			);

			if (this.$hooks["adapterDisconnected"])
				await this.$hooks["adapterDisconnected"](adapter, hash);
		},

		/**
		 * Disconnect all adapters
		 */
		_disconnectAll() {
			const adapters = Array.from(this.adapters.values());
			this.adapters.clear();

			this.logger.info(`Disconnect ${adapters.length} adapters...`);
			return Promise.all(
				adapters.map(({ adapter, hash }) => this._disconnect(adapter, hash))
			);
		},

		/**
		 * Apply scopes for the params query.
		 *
		 * @param {Object} params
		 * @param {Context?} ctx
		 */
		async _applyScopes(params, ctx) {
			let scopes = null;
			if (params.scope) {
				scopes = Array.isArray(params.scope) ? params.scope : [params.scope];
			} else if (params.scope === false) {
				// Disable default scopes, check the permission for this
				if (!(await this.checkScopeAuthority(ctx, null, null))) {
					scopes = this.settings.defaultScopes;
				}
			} else {
				scopes = this.settings.defaultScopes;
			}

			if (scopes && scopes.length > 0) {
				this.logger.debug(`Applying scopes...`, scopes);
				scopes = await this._filterScopeNamesByPermission(ctx, scopes);
				params.query = scopes.reduce((query, scopeName) => {
					const scope = this.settings.scopes[scopeName];
					if (!scope) return query;

					if (_.isFunction(scope)) return scope.call(this, query, ctx);
					else return _.defaultsDeep(query, scope);
				}, _.cloneDeep(params.query || {}));
			}

			return params;
		},

		/**
		 * Filter the scopes according to permissions.
		 *
		 * @param {Context?} ctx
		 * @param {Array<String>} scopeNames
		 * @returns {Array<String>}
		 */
		async _filterScopeNamesByPermission(ctx, scopeNames) {
			const res = [];
			for (const scopeName of scopeNames) {
				const scope = this.settings.scopes[scopeName];
				if (!scope) continue;

				const has = await this.checkScopeAuthority(ctx, scopeName, scope);
				if (has) {
					res.push(scopeName);
				}
			}
			return res;
		},

		/**
		 * Sanitize incoming parameters for `find`, `list`, `count` actions.
		 *
		 * @param {Object} params
		 * @param {Object?} opts
		 * @returns {Object}
		 */
		sanitizeParams(params, opts) {
			const p = Object.assign({}, params);
			if (typeof p.limit === "string") p.limit = Number(p.limit);
			if (typeof p.offset === "string") p.offset = Number(p.offset);
			if (typeof p.page === "string") p.page = Number(p.page);
			if (typeof p.pageSize === "string") p.pageSize = Number(p.pageSize);

			if (typeof p.query === "string") p.query = JSON.parse(p.query);

			if (typeof p.sort === "string") p.sort = p.sort.replace(/,/g, " ").split(" ");
			if (typeof p.fields === "string") p.fields = p.fields.replace(/,/g, " ").split(" ");
			if (typeof p.populate === "string")
				p.populate = p.populate.replace(/,/g, " ").split(" ");
			if (typeof p.searchFields === "string")
				p.searchFields = p.searchFields.replace(/,/g, " ").split(" ");
			if (typeof p.scope === "string") p.scope = p.scope.replace(/,/g, " ").split(" ");

			if (opts && opts.removeLimit) {
				if (p.limit) delete p.limit;
				if (p.offset) delete p.offset;
				if (p.page) delete p.page;
				if (p.pageSize) delete p.pageSize;

				return p;
			}

			if (opts && opts.list) {
				// Default `pageSize`
				if (!p.pageSize) p.pageSize = mixinOpts.defaultPageSize;

				// Default `page`
				if (!p.page) p.page = 1;

				// Limit the `pageSize`
				if (mixinOpts.maxLimit > 0 && p.pageSize > mixinOpts.maxLimit)
					p.pageSize = mixinOpts.maxLimit;

				// Calculate the limit & offset from page & pageSize
				p.limit = p.pageSize;
				p.offset = (p.page - 1) * p.pageSize;
			}
			// Limit the `limit`
			if (mixinOpts.maxLimit > 0 && p.limit > mixinOpts.maxLimit)
				p.limit = mixinOpts.maxLimit;

			return p;
		},

		/**
		 * Find all entities by query & limit.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async findEntities(ctx, params = ctx.params, opts = {}) {
			params = this.sanitizeParams(params);
			params = await this._applyScopes(params, ctx);
			params = this.paramsFieldNameConversion(params);

			const adapter = await this.getAdapter(ctx);

			this.logger.debug(`Find entities`, params);
			let result = await adapter.find(params);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, params, ctx);
			}
			return result;
		},

		/**
		 * Find all entities by query & limit.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 * @returns {Promise<Stream>}
		 */
		async streamEntities(ctx, params = ctx.params, opts = {}) {
			params = this.sanitizeParams(params);
			params = await this._applyScopes(params, ctx);
			params = this.paramsFieldNameConversion(params);

			this.logger.debug(`Stream entities`, params);
			const adapter = await this.getAdapter(ctx);
			const stream = await adapter.findStream(params);

			if (opts.transform !== false) {
				const self = this;
				const transform = new Transform({
					objectMode: true,
					transform: async function (doc, encoding, done) {
						const res = await self.transformResult(adapter, doc, params, ctx);
						this.push(res);
						return done();
					}
				});
				stream.pipe(transform);
				return transform;
			}

			return stream;
		},

		/**
		 * Count entities by query & limit.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 */
		async countEntities(ctx, params = ctx.params) {
			params = this.sanitizeParams(params, { removeLimit: true });
			params = await this._applyScopes(params, ctx);
			params = this.paramsFieldNameConversion(params);

			this.logger.debug(`Count entities`, params);
			const adapter = await this.getAdapter(ctx);
			const result = await adapter.count(params);
			return result;
		},

		/**
		 * Find only one entity by query.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async findEntity(ctx, params = ctx.params, opts = {}) {
			params = this.sanitizeParams(params, { removeLimit: true });
			params = await this._applyScopes(params, ctx);
			params = this.paramsFieldNameConversion(params);
			params.limit = 1;

			this.logger.debug(`Find an entity`, params);
			const adapter = await this.getAdapter(ctx);
			let result = await adapter.findOne(params);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, params, ctx);
			}
			return result;
		},

		/**
		 * Get ID value from `params`.
		 *
		 * @param {Object} params
		 */
		_getIDFromParams(params, throwIfNotExist = true) {
			let id = params[this.$primaryField.name];

			if (throwIfNotExist && id == null) {
				throw new MoleculerClientError("Missing id field.", 400, "MISSING_ID", { params });
			}

			return id;
		},

		/**
		 * Resolve entities by IDs with mapping.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async resolveEntities(ctx, params = ctx.params, opts = {}) {
			// Get ID value from params
			let id = this._getIDFromParams(params);
			const origID = id;
			const origParams = params;
			const multi = Array.isArray(id);
			if (!multi) id = [id];

			// Decode ID if need
			id = id.map(id => this._sanitizeID(id, opts));

			// Apply scopes & set ID filtering
			params = Object.assign({}, params);
			if (!params.query) params.query = {};
			params = await this._applyScopes(params, ctx);
			params = this.paramsFieldNameConversion(params);

			let idField = this.$primaryField.columnName;

			if (multi) {
				params.query[idField] = { $in: id };
			} else {
				params.query[idField] = id[0];
			}

			this.logger.debug(`Resolve entities`, id);
			const adapter = await this.getAdapter(ctx);

			// Find the entities
			let result = await adapter.find(params);
			if (!result || result.length == 0) {
				if (opts.throwIfNotExist) throw new EntityNotFoundError(origID);
				return params.mapping === true ? {} : multi ? [] : null;
			}

			if (this.$hooks["afterResolveEntities"]) {
				await this.$hooks["afterResolveEntities"](
					ctx,
					multi ? id : id[0],
					multi ? result : result[0],
					origParams,
					opts
				);
			}

			// For mapping
			const unTransformedRes = Array.from(result);

			// Transforming
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, params, ctx);
			}

			// Mapping
			if (params.mapping === true) {
				result = result.reduce((map, doc, i) => {
					let id = unTransformedRes[i][idField];
					if (this.$primaryField.secure) id = this.encodeID(id);

					map[id] = doc;
					return map;
				}, {});
			} else if (!multi) {
				result = result[0];
			}

			return result;
		},

		/**
		 * Create an entity.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async createEntity(ctx, params = ctx.params, opts = {}) {
			const adapter = await this.getAdapter(ctx);

			params = await this.validateParams(ctx, params, {
				...opts,
				type: "create",
				nestedFieldSupport: adapter.hasNestedFieldSupport
			});

			this.logger.debug(`Create an entity`, params);
			let result = await adapter.insert(params);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged("create", result, ctx, opts);
			return result;
		},

		/**
		 * Insert multiple entities.
		 *
		 * @param {Context} ctx
		 * @param {Array<Object>?} params
		 * @param {Object?} opts
		 */
		async createEntities(ctx, params = ctx.params, opts = {}) {
			const adapter = await this.getAdapter(ctx);
			const entities = await Promise.all(
				params.map(
					async entity =>
						await this.validateParams(ctx, entity, {
							...opts,
							type: "create",
							nestedFieldSupport: adapter.hasNestedFieldSupport
						})
				)
			);

			this.logger.debug(`Create multiple entities`, entities);
			let result = await adapter.insertMany(entities, {
				returnEntities: opts.returnEntities
			});
			if (opts.returnEntities && opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged("create", result, ctx, { ...opts, batch: true });

			return result;
		},

		/**
		 * Update an entity (patch).
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async updateEntity(ctx, params = ctx.params, opts = {}) {
			params = _.cloneDeep(params);
			const adapter = await this.getAdapter(ctx);
			let id = this._getIDFromParams(params);

			// Call because it throws error if entity is not exist
			const oldEntity = await this.resolveEntities(ctx, params, {
				transform: false,
				throwIfNotExist: true
			});

			const rawUpdate = opts.raw === true;
			if (!rawUpdate) {
				params = await this.validateParams(ctx, params, {
					...opts,
					type: "update",
					oldEntity,
					nestedFieldSupport: adapter.hasNestedFieldSupport
				});
			}

			id = this._sanitizeID(id, opts);

			delete params[this.$primaryField.columnName];
			//if (this.$primaryField.columnName != this.$primaryField.name)
			delete params[this.$primaryField.name];

			this.logger.debug(`Update an entity`, id, params);
			let result;
			const hasChanges = Object.keys(params).length > 0;
			if (hasChanges) {
				result = await adapter.updateById(id, params, { raw: rawUpdate });
			} else {
				// Nothing to update
				result = oldEntity;
			}

			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			if (hasChanges) {
				await this._entityChanged("update", result, ctx, opts);
			}

			return result;
		},

		/**
		 * Update multiple entities (patch).
		 *
		 * @param {Context} ctx
		 * @param {Object} params
		 * @param {Object} params.query
		 * @param {Object} params.changes
		 * @param {Object?} opts
		 */
		async updateEntities(ctx, params = ctx.params, opts = {}) {
			const adapter = await this.getAdapter(ctx);

			const _entities = await this.findEntities(
				ctx,
				{ query: params.query },
				{ transform: false }
			);

			return this.Promise.all(
				_entities.map(async _entity => {
					let entity = adapter.entityToJSON(_entity);
					let id = entity[this.$primaryField.columnName];
					id = this.$primaryField.secure ? this.encodeID(id) : id;

					return await this.updateEntity(
						ctx,
						{
							...params.changes,
							[this.$primaryField.name]: id
						},
						opts
					);
				})
			);
		},

		/**
		 * Replace an entity.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async replaceEntity(ctx, params = ctx.params, opts = {}) {
			let id = this._getIDFromParams(params);

			// Call because it throws error if entity is not exist
			const oldEntity = await this.resolveEntities(ctx, params, {
				transform: false,
				throwIfNotExist: true
			});
			const adapter = await this.getAdapter(ctx);

			params = await this.validateParams(ctx, params, {
				...opts,
				type: "replace",
				oldEntity,
				nestedFieldSupport: adapter.hasNestedFieldSupport
			});

			id = this._sanitizeID(id, opts);

			delete params[this.$primaryField.columnName];
			if (this.$primaryField.columnName != this.$primaryField.name) {
				delete params[this.$primaryField.name];
			}

			this.logger.debug(`Replace an entity`, id, params);
			let result = await adapter.replaceById(id, params);

			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged("replace", result, ctx, opts);
			return result;
		},

		/**
		 * Delete an entity.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async removeEntity(ctx, params = ctx.params, opts = {}) {
			let id = this._getIDFromParams(params);
			const origID = id;

			let entity = await this.resolveEntities(ctx, params, {
				transform: false,
				throwIfNotExist: true
			});

			const adapter = await this.getAdapter(ctx);

			params = await this.validateParams(ctx, params, {
				...opts,
				type: "remove",
				nestedFieldSupport: adapter.hasNestedFieldSupport
			});

			id = this._sanitizeID(id, opts);

			if (this.$softDelete) {
				this.logger.debug(`Soft delete an entity`, id, params);
				// Soft delete
				entity = await adapter.updateById(id, params);
			} else {
				// Real delete
				this.logger.debug(`Delete an entity`, id);
				await adapter.removeById(id);
			}

			if (opts.transform !== false) {
				entity = await this.transformResult(adapter, entity, params, ctx);
			}

			await this._entityChanged("remove", entity, ctx, {
				...opts,
				softDelete: !!this.$softDelete
			});

			return origID;
		},

		/**
		 * Delete multiple entities.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} params.query
		 * @param {Object?} opts
		 */
		async removeEntities(ctx, params = ctx.params, opts = {}) {
			const adapter = await this.getAdapter(ctx);

			const _entities = await this.findEntities(
				ctx,
				{ query: params.query },
				{ transform: false }
			);

			return this.Promise.all(
				_entities.map(async _entity => {
					let entity = adapter.entityToJSON(_entity);
					let id = entity[this.$primaryField.columnName];
					id = this.$primaryField.secure ? this.encodeID(id) : id;

					return await this.removeEntity(
						ctx,
						{
							[this.$primaryField.name]: id
						},
						opts
					);
				})
			);
		},

		/**
		 * Clear all entities.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 */
		async clearEntities(ctx, params) {
			this.logger.debug(`Clear all entities`, params);
			const adapter = await this.getAdapter(ctx);
			const result = await adapter.clear(params);

			await this._entityChanged("clear", null, ctx);

			return result;
		},

		/**
		 * Create indexes.
		 * @param {Adapter?} adapter If null, it gets adapter with `getAdapter()`
		 * @param {Array<Object>?} indexes If null, it uses the `settings.indexes`
		 */
		async createIndexes(adapter, indexes) {
			adapter = await (adapter || this.getAdapter());
			if (!indexes) indexes = this.settings.indexes;
			if (Array.isArray(indexes)) {
				await Promise.all(indexes.map(def => this.createIndex(adapter, def)));
			}
		},

		/**
		 * Create an index.
		 *
		 * @param {Object} def
		 */
		createIndex(adapter, def) {
			const newDef = _.cloneDeep(def);
			this.logger.debug(`Create an index`, def);
			if (_.isString(def.fields))
				newDef.fields = this._getColumnNameFromFieldName(def.fields);
			else if (Array.isArray(def.fields))
				newDef.fields = def.fields.map(f => this._getColumnNameFromFieldName(f));
			else if (_.isPlainObject(def.fields))
				newDef.fields = this._queryFieldNameConversion(def.fields, false);
			return adapter.createIndex(newDef);
		},

		/**
		 * Called when an entity changed.
		 * @param {String} type
		 * @param {any} data
		 * @param {Context?} ctx
		 * @param {Object?} opts
		 */
		async _entityChanged(type, data, ctx, opts = {}) {
			if (cacheOpts.eventType) {
				const eventName = cacheOpts.eventName || `cache.clean.${this.name}`;
				if (cacheOpts && eventName) {
					// Cache cleaning event
					(ctx || this.broker)[cacheOpts.eventType](eventName, {
						type,
						data,
						opts
					});
				}
			}

			await this.entityChanged(type, data, ctx, opts);
		},

		/**
		 * Send entity lifecycle events
		 * @param {String} type
		 * @param {any} data
		 * @param {Context?} ctx
		 * @param {Object?} opts
		 */
		async entityChanged(type, data, ctx, opts) {
			if (mixinOpts.entityChangedEventType) {
				const op = type + (type == "clear" ? "ed" : "d");
				const eventName = `${this.name}.${op}`;

				(ctx || this.broker)[mixinOpts.entityChangedEventType](eventName, {
					type,
					data,
					opts
				});
			}
		},

		/**
		 * Encode ID of entity.
		 *
		 * @methods
		 * @param {any} id
		 * @returns {any}
		 */
		encodeID(id) {
			return id;
		},

		/**
		 * Decode ID of entity.
		 *
		 * @methods
		 * @param {any} id
		 * @returns {any}
		 */
		decodeID(id) {
			return id;
		},

		/**
		 * Sanitize the input ID. Decode if it's secured.
		 * @param {any} id
		 * @param {Object?} opts
		 * @returns {any}
		 */
		_sanitizeID(id, opts) {
			if (opts.secureID != null) {
				return opts.secureID ? this.decodeID(id) : id;
			} else if (this.$primaryField.secure) {
				return this.decodeID(id);
			}
			return id;
		},

		/**
		 * Get the columnName from field name.
		 *
		 * @param {String} fieldName
		 * @returns {String} columnName
		 */
		_getColumnNameFromFieldName(fieldName) {
			const res = cacheColumnName.get(fieldName);
			if (res) return res;

			const field = this.$fields.find(f => f.name == fieldName);
			if (field) {
				cacheColumnName.set(fieldName, field.columnName);
				return field.columnName;
			}
			return fieldName;
		},

		/**
		 * Convert fieldName to columnName in `sort`
		 * @param {Array<String>} sort
		 * @returns {Array<String>}
		 */
		_sortFieldNameConversion(sort) {
			return sort.map(fieldName => {
				if (fieldName.startsWith("-")) {
					return "-" + this._getColumnNameFromFieldName(fieldName.slice(1));
				} else {
					return this._getColumnNameFromFieldName(fieldName);
				}
			});
		},

		/**
		 * Convert fieldName to columnName in `query`
		 * @param {Object} query
		 * @param {Boolean} recursive
		 * @returns {Object}
		 */
		_queryFieldNameConversion(query, recursive) {
			return Object.keys(query).reduce((res, fieldName) => {
				const columnName = this._getColumnNameFromFieldName(fieldName);
				if (_.isPlainObject(res[columnName]) && recursive) {
					res[columnName] = this._queryFieldNameConversion(query[fieldName], recursive);
				} else {
					res[columnName] = query[fieldName];
				}
				return res;
			}, {});
		},

		/**
		 * Convert field names to column names in `params`
		 * @param {Object} p
		 * @returns {Object}
		 */
		paramsFieldNameConversion(p) {
			// Fieldname -> columnName conversions
			if (p.sort) {
				p.sort = this._sortFieldNameConversion(p.sort);
			}
			if (p.searchFields) {
				p.searchFields = this._sortFieldNameConversion(p.searchFields);
			}
			if (p.query) {
				p.query = this._queryFieldNameConversion(p.query, true);
			}

			return p;
		}
	};
};
