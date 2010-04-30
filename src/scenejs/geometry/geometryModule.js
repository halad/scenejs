/**
 * Services geometry node requests to store and render elements of geometry.
 *
 * Stores geometry in vertex buffers in video RAM, caching them there under a least-recently-used eviction policy
 * mediated by the "memory" backend.
 *
 * Geometry elements are identified by type IDs, which may either be supplied by scene nodes, or automatically
 * generated by this backend.
 *
 * After creating geometry, the backend returns to the node the type ID for the node to retain. The node
 * can then pass in the type ID to test if the geometry still exists (perhaps it has been evicted) or to have the
 * backend render the geometry.
 *
 * The backend is free to evict whatever geometry it chooses between scene traversals, so the node must always check
 * the existence of the geometry and possibly request its re-creation each time before requesting the backend render it.
 *
 * A geometry buffer consists of positions, normals, optional texture coordinates, indices and a primitive type
 * (eg. "triangles").
 *
 * When rendering a geometry element, the backend will first fire a GEOMETRY_UPDATED to give the shader backend a
 * chance to prepare a shader script to render the geometry for current scene state. Then it will fire a SHADER_ACTIVATE
 * to prompt the shader backend to fire a SHADER_ACTIVATED to marshal resources from various backends (including this one)
 * for its shader script variables, which then provide their resources to the shader through XXX_EXPORTED events.
 * This backend then likewise provides its geometry buffers to the shader backend through a GEOMETRY_EXPORTED event,
 * then bind and draw the index buffer.
 *
 * The backend avoids needlessly re-exporting and re-binding geometry (eg. when rendering a bunch of cubes in a row)
 * by tracking the type of the last geometry rendered. That type is maintained until another either geoemetry is rendered,
 * the canvas switches, shader deactivates or scene deactivates.
 *
 *  @private

 */
var SceneJS_geometryModule = new (function() {

    var time = (new Date()).getTime();  // For LRU caching
    var canvas;
    var geoMaps = {};                   // Geometry map for each canvas
    var currentGeoMap = null;
    var currentBoundGeoType;            // Type of geometry currently bound to shader

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.TIME_UPDATED,
            function(t) {
                time = t;
            });

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.SCENE_ACTIVATED,
            function() {
                canvas = null;
                currentGeoMap = null;
                currentBoundGeoType = null;
            });

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.CANVAS_ACTIVATED,
            function(c) {
                if (!geoMaps[c.canvasId]) {      // Lazy-create geometry map for canvas
                    geoMaps[c.canvasId] = {};
                }
                canvas = c;
                currentGeoMap = geoMaps[c.canvasId];
                currentBoundGeoType = null;
            });

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.CANVAS_DEACTIVATED,
            function() {
                canvas = null;
                currentGeoMap = null;
                currentBoundGeoType = null;
            });

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.SHADER_ACTIVATED,
            function() {
                currentBoundGeoType = null;
            });

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.SHADER_DEACTIVATED,
            function() {
                currentBoundGeoType = null;
            });

    SceneJS_eventModule.onEvent(
            SceneJS_eventModule.RESET,
            function() {
                for (var canvasId in geoMaps) {    // Destroy geometries on all canvases
                    var geoMap = geoMaps[canvasId];
                    for (var type in geoMap) {
                        var geometry = geoMap[type];
                        destroyGeometry(geometry);
                    }
                }
                canvas = null;
                geoMaps = {};
                currentGeoMap = null;
                currentBoundGeoType = null;
            });

    /**
     * Destroys geometry, returning true if memory freed, else false
     * where canvas not found and geometry was implicitly destroyed
     * @private
     */
    function destroyGeometry(geo) {
        //  SceneJS_loggingModule.debug("Destroying geometry : '" + geo.type + "'");
        if (geo.type == currentBoundGeoType) {
            currentBoundGeoType = null;
        }
        if (document.getElementById(geo.canvas.canvasId)) { // Context won't exist if canvas has disappeared
            if (geo.vertexBuf) {
                geo.vertexBuf.destroy();
            }
            if (geo.normalBuf) {
                geo.normalBuf.destroy();
            }
            if (geo.normalBuf) {
                geo.indexBuf.destroy();
            }
            if (geo.uvBuf) {
                geo.uvBuf.destroy();
            }
            if (geo.uvBuf2) {
                geo.uvBuf2.destroy();
            }
        }
        var geoMap = geoMaps[geo.canvas.canvasId];
        if (geoMap) {
            geoMap[geo.type] = null;
        }
    }

    /**
     * Volunteer to attempt to destroy a geometry when asked to by memory module
     *
     */
    SceneJS_memoryModule.registerEvictor(
            function() {
                var earliest = time;
                var evictee;
                for (var canvasId in geoMaps) {
                    var geoMap = geoMaps[canvasId];
                    if (geoMap) {
                        for (var type in geoMap) {
                            var geometry = geoMap[type];
                            if (geometry) {
                                if (geometry.lastUsed < earliest
                                        && document.getElementById(geometry.canvas.canvasId)) { // Canvas must still exist
                                    evictee = geometry;
                                    earliest = geometry.lastUsed;
                                }
                            }
                        }
                    }
                }
                if (evictee) {
                    SceneJS_loggingModule.warn("Evicting geometry from memory: " + evictee.type);
                    destroyGeometry(evictee);
                    return true;
                }
                return false;  // Couldnt find a geometry we can delete
            });

    /**
     * Creates an array buffer
     *
     * @private
     * @param context WebGL context
     * @param bufType Eg. ARRAY_BUFFER
     * @param values WebGL array
     * @param numItems
     * @param itemSize
     * @param usage Eg. STATIC_DRAW
     */
    function createArrayBuffer(description, context, bufType, values, numItems, itemSize, usage) {
        var buf;
        SceneJS_memoryModule.allocate(
                description,
                function() {
                    buf = new SceneJS_webgl_ArrayBuffer(context, bufType, values, numItems, itemSize, usage);
                });
        return buf;
    }

    /**
     * Converts SceneJS primitive type string to WebGL constant
     * @private
     */
    function getPrimitiveType(context, primitive) {
        switch (primitive) {
            case "points":
                return context.POINTS;
            case "lines":
                return context.LINES;
            case "line-loop":
                return context.LINE_LOOP;
            case "line-strip":
                return context.LINE_STRIP;
            case "triangles":
                return context.TRIANGLES;
            case "triangle-strip":
                return context.TRIANGLE_STRIP;
            case "triangle-fan":
                return context.TRIANGLE_FAN;
            default:
                SceneJS_errorModule.fatalError(new SceneJS.exceptions.InvalidGeometryConfigException(// Logs and throws
                        "SceneJS.geometry primitive unsupported: '" +
                        primitive +
                        "' - supported types are: 'points', 'lines', 'line-loop', " +
                        "'line-strip', 'triangles', 'triangle-strip' and 'triangle-fan'"));
        }
    }


    /**
     * Tests if the given geometry type exists on the currently active canvas
     * @private
     */
    this.testGeometryExists = function(type) {
        return currentGeoMap[type] ? true : false;
    };

    /**
     * Creates geometry on the active canvas - can optionally take a type ID. On success, when ID given
     * will return that ID, else if no ID given, will return a generated one.
     * @private
     */
    this.createGeometry = function(type, data) {
        if (!type) {
            type = SceneJS._utils.createKeyForMap(currentGeoMap, "type");
        }

        //   SceneJS_loggingModule.debug("Creating geometry: '" + type + "'");

        if (!data.primitive) { // "points", "lines", "line-loop", "line-strip", "triangles", "triangle-strip" or "triangle-fan"
            SceneJS_errorModule.fatalError(
                    new SceneJS.exceptions.NodeConfigExpectedException(
                            "SceneJS.geometry node property expected : primitive"));
        }
        var context = canvas.context;
        var usage = context.STATIC_DRAW;
        //var usage = (!data.fixed) ? context.STREAM_DRAW : context.STATIC_DRAW;

        var vertexBuf;
        var normalBuf;
        var uvBuf;
        var uvBuf2;
        var indexBuf;

        try { // TODO: Modify usage flags in accordance with how often geometry is evicted

            vertexBuf = createArrayBuffer("geometry vertex buffer", context, context.ARRAY_BUFFER,
                    new WebGLFloatArray(data.positions), data.positions.length, 3, usage);

            if (data.normals && data.normals.length > 0) {
                normalBuf = createArrayBuffer("geometry normal buffer", context, context.ARRAY_BUFFER,
                        new WebGLFloatArray(data.normals), data.normals.length, 3, usage);
            }

            if (data.uv && data.uv.length > 0) {
                if (data.uv) {
                    uvBuf = createArrayBuffer("geometry UV buffer", context, context.ARRAY_BUFFER,
                            new WebGLFloatArray(data.uv), data.uv.length, 2, usage);
                }
            }

            if (data.uv2 && data.uv2.length > 0) {
                if (data.uv2) {
                    uvBuf2 = createArrayBuffer("geometry UV2 buffer", context, context.ARRAY_BUFFER,
                            new WebGLFloatArray(data.uv2), data.uv2.length, 2, usage);
                }
            }

            indexBuf = createArrayBuffer("geometry index buffer", context, context.ELEMENT_ARRAY_BUFFER,
                    new WebGLUnsignedShortArray(data.indices), data.indices.length, 1, usage);

            var geo = {
                fixed : true, // TODO: support dynamic geometry
                primitive: getPrimitiveType(context, data.primitive),
                type: type,
                lastUsed: time,
                canvas : canvas,
                context : context,
                vertexBuf : vertexBuf,
                normalBuf : normalBuf,
                indexBuf : indexBuf,
                uvBuf: uvBuf,
                uvBuf2: uvBuf2
            };
            currentGeoMap[type] = geo;
            return type;
        } catch (e) { // Allocation failure - delete whatever buffers got allocated

            if (vertexBuf) {
                vertexBuf.destroy();
            }
            if (normalBuf) {
                normalBuf.destroy();
            }
            if (uvBuf) {
                uvBuf.destroy();
            }
            if (uvBuf2) {
                uvBuf2.destroy();
            }
            if (indexBuf) {
                indexBuf.destroy();
            }
            throw e;
        }
    };

    /**
     * Draws the geometry of the given ID that exists on the current canvas.
     * Client node must ensure prior that the geometry exists on the canvas
     * using findGeometry, and have created it if neccessary with createGeometry.
     * @private
     */
    this.drawGeometry = function(type) {
        if (!canvas) {
            SceneJS_errorModule.fatalError(SceneJS.exceptions.NoCanvasActiveException("No canvas active"));
        }
        var geo = currentGeoMap[type];

        SceneJS_eventModule.fireEvent(SceneJS_eventModule.GEOMETRY_UPDATED, geo);  // Gives shader backend a chance to generate a shader

        /* Prompt shader backend to in turn prompt for exports from all backends.
         * This backend exports proactively however (see below), since it is the one
         * which prompted the shader backend.
         */
        SceneJS_eventModule.fireEvent(SceneJS_eventModule.SHADER_ACTIVATE);

        geo.lastUsed = time;  // Geometry now not evictable in this scene traversal

        var context = canvas.context;

        /* Dont re-export and bind if already the last one exported and bound - this is the case when
         * we're drawing a batch of the same object, Eg. a bunch of cubes in a row
         */
        if (currentBoundGeoType != type) {
            for (var i = 0; i < 8; i++) {
                context.disableVertexAttribArray(i);
            }
            SceneJS_eventModule.fireEvent(
                    SceneJS_eventModule.GEOMETRY_EXPORTED,
                    geo);

            geo.indexBuf.bind(); // Bind index buffer

            currentBoundGeoType = type;
        }

        /* Draw geometry
         */
        context.drawElements(geo.primitive, geo.indexBuf.numItems, context.UNSIGNED_SHORT, 0);
        context.flush();

        /* Don't need to unbind buffers - only one is bound at a time anyway
         */

        /* Destroy one-off geometry
         */
        //                    if (!geo.fixed) {
        //                        destroyGeometry(geo);
        //                        currentBoundGeoType = null;
        //                    }
    };
})();