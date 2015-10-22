/**
 * Delete an entity.
 * @param {String} entity_type
 * @param {Number} ids
 * @param {Object} options
 */
function entity_delete(entity_type, ids, options) {
  try {
    var function_name = entity_type + '_delete';
    if (function_exists(function_name)) {
      var fn = window[function_name];
      fn(ids, options);
    }
    else {
      console.log('WARNING: entity_delete - unsupported type: ' + entity_type);
    }
  }
  catch (error) { console.log('entity_delete - ' + error); }
}

/**
 * Parses an entity id and returns it as an integer (not a string).
 * @param {*} entity_id
 * @return {Number}
 */
function entity_id_parse(entity_id) {
  try {
    var id = entity_id;
    if (typeof id === 'string') { id = parseInt(entity_id); }
    return id;
  }
  catch (error) { console.log('entity_id_parse - ' + error); }
}

/**
 * Given an entity type and the entity id, this will return the local storage
 * key to be used when saving/loading the entity from local storage.
 * @param {String} entity_type
 * @param {Number} id
 * @return {String}
 */
function entity_local_storage_key(entity_type, id) {
  try {
    return entity_type + '_' + id;
  }
  catch (error) { console.log('entity_local_storage_key - ' + error); }
}

/**
 * A placeholder function used to provide a local storage key for entity index
 * queries.
 */
function entity_index_local_storage_key(path) {
  return path;
}

/**
 * Loads an entity.
 * @param {String} entity_type
 * @param {Number} ids
 * @param {Object} options
 */
function entity_load(entity_type, ids, options) {
  try {
    if (!is_int(ids)) {
      // @TODO - if an array of ints is sent in, call entity_index() instead.
      var msg = 'entity_load(' + entity_type + ') - only single ids supported!';
      console.log(msg);
      return;
    }
    var caching_enabled = entity_caching_enabled();
    var entity_id = ids;
    // Convert the id to an int, if it's a string.
    entity_id = entity_id_parse(entity_id);
    // If this entity is already queued for retrieval, set the success and
    // error callbacks aside, and return. Unless entity caching is enabled and
    // we have a copy of the entity in local storage, then send it to the
    // provided success callback.
    if (_services_queue_already_queued(
      entity_type,
      'retrieve',
      entity_id,
      'success'
    )) {
      if (caching_enabled) {
        entity = _entity_local_storage_load(entity_type, entity_id, options);
        if (entity) {
          if (options.success) { options.success(entity); }
          return;
        }
      }
      if (typeof options.success !== 'undefined') {
        _services_queue_callback_add(
          entity_type,
          'retrieve',
          entity_id,
          'success',
          options.success
        );
      }
      if (typeof options.error !== 'undefined') {
        _services_queue_callback_add(
          entity_type,
          'retrieve',
          entity_id,
          'error',
          options.error
        );
      }
      return;
    }

    // This entity has not been queued for retrieval, queue it and its callback.
    _services_queue_add_to_queue(entity_type, 'retrieve', entity_id);
    _services_queue_callback_add(
      entity_type,
      'retrieve',
      entity_id,
      'success',
      options.success
    );

    // If entity caching is enabled, try to load the entity from local storage.
    // If a copy is available in local storage, send it to the success callback.
    var entity = false;
    if (caching_enabled) {
      entity = _entity_local_storage_load(entity_type, entity_id, options);
      if (entity) {
        if (options.success) { options.success(entity); }
        return;
      }
    }

    // Verify the entity type is supported.
    if (!in_array(entity_type, entity_types())) {
      var message = 'WARNING: entity_load - unsupported type: ' + entity_type;
      console.log(message);
      if (options.error) { options.error(null, null, message); }
      return;
    }

    // We didn't load the entity from local storage. Let's grab it from the
    // Drupal server instead. First, let's build the call options.
    var primary_key = entity_primary_key(entity_type);
    var call_options = {
      success: function(data) {
        try {

          // Set the entity equal to the returned data.
          entity = data;

          // If entity caching is enabled, set its expiration time and save it
          // to local storage.
          if (caching_enabled) {
            _entity_set_expiration_time(entity);
            _entity_local_storage_save(entity_type, entity_id, entity);
          }

          // Send the entity back to the queued callback(s), then clear out the
          // callbacks.
          var _success_callbacks =
            Drupal.services_queue[entity_type]['retrieve'][entity_id].success;
          for (var i = 0; i < _success_callbacks.length; i++) {
            _success_callbacks[i](entity);
          }
          Drupal.services_queue[entity_type]['retrieve'][entity_id].success =
            [];

        }
        catch (error) {
          console.log('entity_load - success - ' + error);
        }
      },
      error: function(xhr, status, message) {
        try {
          if (options.error) { options.error(xhr, status, message); }
        }
        catch (error) {
          console.log('entity_load - error - ' + error);
        }
      }
    };

    // Finally, determine the entity's retrieve function and call it.
    var function_name = entity_type + '_retrieve';
    if (function_exists(function_name)) {
      call_options[primary_key] = entity_id;
      var fn = window[function_name];
      fn(ids, call_options);
    }
    else {
      console.log('WARNING: ' + function_name + '() does not exist!');
    }
  }
  catch (error) { console.log('entity_load - ' + error); }
}

/**
 * An internal function used by entity_load() to attempt loading an entity
 * from local storage.
 * @param {String} entity_type
 * @param {Number} entity_id
 * @param {Object} options
 * @return {Object}
 */
function _entity_local_storage_load(entity_type, entity_id, options) {
  try {
    var entity = false;
    // Process options if necessary.
    if (options) {
      // If we are resetting, remove the item from localStorage.
      if (options.reset) {
        _entity_local_storage_delete(entity_type, entity_id);
      }
    }
    // Attempt to load the entity from local storage.
    var local_storage_key = entity_local_storage_key(entity_type, entity_id);
    entity = window.localStorage.getItem(local_storage_key);
    if (entity) {
      entity = JSON.parse(entity);
      // We successfully loaded the entity from local storage. If it expired
      // remove it from local storage then continue onward with the entity
      // retrieval from Drupal. Otherwise return the local storage entity copy.
      if (typeof entity.expiration !== 'undefined' &&
          entity.expiration != 0 &&
          time() > entity.expiration) {
        _entity_local_storage_delete(entity_type, entity_id);
        entity = false;
      }
      else {

        // @todo - this code belongs to DrupalGap! Figure out how to bring the
        // idea of DrupalGap modules into jDrupal that way jDrupal can provide
        // a hook for DrupalGap to take care of this code!

        // The entity has not yet expired. If the current page options
        // indicate reloadingPage is true (and the reset option wasn't set to
        // false) then we'll grab a fresh copy of the entity from Drupal.
        // If the page is reloading and the developer didn't call for a reset,
        // then just return the cached copy.
        if (drupalgap && drupalgap.page.options &&
          drupalgap.page.options.reloadingPage) {
          // Reloading page... cached entity is still valid.
          if (typeof drupalgap.page.options.reset !== 'undefined' &&
            drupalgap.page.options.reset === false) {
            // We were told to not reset it, so we'll use the cached copy.
            return entity;
          }
          else {
            // Remove the entity from local storage and reset it.
            _entity_local_storage_delete(entity_type, entity_id);
            entity = false;
          }
        }
      }
    }
    return entity;
  }
  catch (error) { console.log('_entity_local_storage_load - ' + error); }
}

/**
 * An internal function used to save an entity to local storage.
 * @param {String} entity_type
 * @param {Number} entity_id
 * @param {Object} entity
 */
function _entity_local_storage_save(entity_type, entity_id, entity) {
  try {
    window.localStorage.setItem(
      entity_local_storage_key(entity_type, entity_id),
      JSON.stringify(entity)
    );
  }
  catch (error) { console.log('_entity_local_storage_save - ' + error); }
}

/**
 * An internal function used to delete an entity from local storage.
 * @param {String} entity_type
 * @param {Number} entity_id
 */
function _entity_local_storage_delete(entity_type, entity_id) {
  try {
    var storage_key = entity_local_storage_key(
      entity_type,
      entity_id
    );
    window.localStorage.removeItem(storage_key);
  }
  catch (error) { console.log('_entity_local_storage_delete - ' + error); }
}

/**
 * Returns an entity type's primary key.
 * @param {String} entity_type
 * @return {String}
 */
function entity_primary_key(entity_type) {
  try {
    var key;
    switch (entity_type) {
      case 'comment': key = 'cid'; break;
      case 'file': key = 'fid'; break;
      case 'node': key = 'nid'; break;
      case 'taxonomy_term': key = 'tid'; break;
      case 'taxonomy_vocabulary': key = 'vid'; break;
      case 'user': key = 'uid'; break;
      default:
        // Is anyone declaring the primary key for this entity type?
        var function_name = entity_type + '_primary_key';
        if (drupalgap_function_exists(function_name)) {
          var fn = window[function_name];
          key = fn(entity_type);
        }
        else {
          var msg = 'entity_primary_key - unsupported entity type (' +
            entity_type + ') - to add support, declare ' + function_name +
            '() and have it return the primary key column name as a string';
          console.log(msg);
        }
        break;
    }
    return key;
  }
  catch (error) { console.log('entity_primary_key - ' + error); }
}

/**
 * Saves an entity.
 * @param {String} entity_type
 * @param {String} bundle
 * @param {Object} entity
 * @param {Object} options
 */
function entity_save(entity_type, bundle, entity, options) {
  try {
    var function_name;
    switch (entity_type) {
      case 'comment':
        if (!entity.cid) { function_name = 'comment_create'; }
        else { function_name = 'comment_update'; }
        break;
      case 'file':
        function_name = 'file_create';
        break;
      case 'node':
        if (!entity.language) { entity.language = language_default(); }
        if (!entity.nid) { function_name = 'node_create'; }
        else { function_name = 'node_update'; }
        break;
      case 'user':
        if (!entity.uid) { function_name = 'user_create'; }
        else { function_name = 'user_update'; }
        break;
      case 'taxonomy_term':
        if (!entity.tid) { function_name = 'taxonomy_term_create'; }
        else { function_name = 'taxonomy_term_update'; }
        break;
      case 'taxonomy_vocabulary':
        if (!entity.vid) { function_name = 'taxonomy_vocabulary_create'; }
        else { function_name = 'taxonomy_vocabulary_update'; }
        break;
    }
    if (function_name && function_exists(function_name)) {
      var fn = window[function_name];
      fn(entity, options);
    }
    else {
      console.log('WARNING: entity_save - unsupported type: ' + entity_type);
    }
  }
  catch (error) { console.log('entity_save - ' + error); }
}

/**
 *
 */
function entity_caching_enabled() {
  try {
    return Drupal.settings.cache.entity &&
      Drupal.settings.cache.entity.enabled;
  }
  catch (error) { console.log('entity_caching_enabled - ' + error); }
}

/**
 *
 */
function _entity_get_expiration_time() {
  try {
    var expiration = null;
    if (
      Drupal.settings.cache.entity.enabled &&
      Drupal.settings.cache.entity.expiration !== 'undefined'
    ) {
      expiration = Drupal.settings.cache.entity.expiration === 0 ?
        0 : time() + Drupal.settings.cache.entity.expiration;
    }
    return expiration;
  }
  catch (error) { console.log('_entity_get_expiration_time - ' + error); }
}

/**
 *
 */
function _entity_set_expiration_time(entity) {
  try {
    entity.expiration = _entity_get_expiration_time();
  }
  catch (error) { console.log('_entity_set_expiration_time - ' + error); }
}

/**
 * Returns an array of entity type names.
 * @return {Array}
 */
function entity_types() {
  try {
    return [
      'comment',
      'file',
      'node',
      'taxonomy_term',
      'taxonomy_vocabulary',
      'user'
    ];
  }
  catch (error) { console.log('entity_types - ' + error); }
}

/**
 * An internal function used by entity_index() to attempt loading a specific
 * query's results from local storage.
 * @param {String} entity_type
 * @param {String} path The URL path used by entity_index(), used as the cache key.
 * @param {Object} options
 * @return {Object}
 */
function _entity_index_local_storage_load(entity_type, path, options) {
  try {
    var _entity_index = false;
    // Process options if necessary.
    if (options) {
      // If we are resetting, remove the item from localStorage.
      if (options.reset) {
        _entity_index_local_storage_delete(path);
      }
    }
    // Attempt to load the entity_index from local storage.
    var local_storage_key = entity_index_local_storage_key(path);
    _entity_index = window.localStorage.getItem(local_storage_key);
    if (_entity_index) {
      _entity_index = JSON.parse(_entity_index);
      // We successfully loaded the entity_index result ids from local storage. If it expired
      // remove it from local storage then continue onward with the entity_index
      // retrieval from Drupal. Otherwise return the local storage entity_index copy.
      if (typeof _entity_index.expiration !== 'undefined' &&
          _entity_index.expiration != 0 &&
          time() > _entity_index.expiration) {
        _entity_index_local_storage_delete(path);
        _entity_index = false;
      }
      else {
        // The entity_index has not yet expired, so pull each entity out of
        // local storage, add them to the result array, and return the array.
        var result = [];
        for (var i = 0; i < _entity_index.entity_ids.length; i++) {
          result.push(
            _entity_local_storage_load(
              entity_type,
              _entity_index.entity_ids[i],
              options
            )
          );
        }
        _entity_index = result;
      }
    }
    return _entity_index;
  }
  catch (error) { console.log('_entity_index_local_storage_load - ' + error); }
}

/**
 * An internal function used to save an entity_index result entity ids to
 * local storage.
 * @param {String} entity_type
 * @param {String} path
 * @param {Object} result
 */
function _entity_index_local_storage_save(entity_type, path, result) {
  try {
    var index = {
      entity_type: entity_type,
      expiration: _entity_get_expiration_time(),
      entity_ids: []
    };
    for (var i = 0; i < result.length; i++) {
      index.entity_ids.push(result[i][entity_primary_key(entity_type)]);
    }
    window.localStorage.setItem(
      entity_index_local_storage_key(path),
      JSON.stringify(index)
    );
  }
  catch (error) { console.log('_entity_index_local_storage_save - ' + error); }
}

/**
 * An internal function used to delete an entity_index from local storage.
 * @param {String} path
 */
function _entity_index_local_storage_delete(path) {
  try {
    var storage_key = entity_index_local_storage_key(path);
    window.localStorage.removeItem(storage_key);
  }
  catch (error) { console.log('_entity_index_local_storage_delete - ' + error); }
}

