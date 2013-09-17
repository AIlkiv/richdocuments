/**
 * @license
 * Copyright (C) 2013 KO GmbH <copyright@kogmbh.com>
 *
 * @licstart
 * The JavaScript code in this page is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License
 * (GNU AGPL) as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.  The code is distributed
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU AGPL for more details.
 *
 * As additional permission under GNU AGPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * As a special exception to the AGPL, any HTML file which merely makes function
 * calls to this code, and for that purpose includes it by reference shall be
 * deemed a separate work for copyright law purposes. In addition, the copyright
 * holders of this code give you permission to combine this code with free
 * software libraries that are released under the GNU LGPL. You may copy and
 * distribute such a system following the terms of the GNU AGPL for this code
 * and the LGPL for the libraries. If you modify this code, you may extend this
 * exception to your version of the code, but you are not obligated to do so.
 * If you do not wish to do so, delete this exception statement from your
 * version.
 *
 * This license applies to this entire compilation.
 * @licend
 * @source: http://www.webodf.org/
 * @source: http://gitorious.org/webodf/webodf/
 */

/*global runtime, ops*/

define("webodf/editor/server/pullbox/OperationRouter", [], function () {
    "use strict";

    runtime.loadClass("ops.OperationTransformer");

    /**
     * route operations in a networked collaborative manner.
     *
     * incoming operations (from controller) are sent to a server,
     * who will distribute them.
     *
     * incoming operations (from the server are played on the DOM.
     */

    /**
     * @constructor
     * @implements ops.OperationRouter
     */
    return function PullBoxOperationRouter(sessionId, memberId, server, odfContainer) {
        "use strict";

        var operationFactory,
            /**@type{function(!ops.Operation)}*/
            playbackFunction,
            idleTimeout = null,
            syncOpsTimeout = null,
            /**@type{!boolean}*/
            isInstantSyncRequested = false,
            /**@type{!boolean}*/
            isPlayingUnplayedServerOpSpecs = false,
            /**@type{!boolean}*/
            isSyncCallRunning = false,
            /**@type{!boolean}*/
            hasUnresolvableConflict = false,
            /**@type{!boolean}*/
            syncingBlocked = false,
            /** @type {!string} id of latest op stack state known on the server */
            lastServerSeq = "",
            /** @type {!Array.<!Function>} sync request callbacks created since the last sync call to the server */
            syncRequestCallbacksQueue = [],
            /** @type {!Array.<!Object>} ops created since the last sync call to the server */
            unsyncedClientOpspecQueue = [],
            /** @type {!Array.<!Object>} ops already received from the server but not yet applied */
            unplayedServerOpspecQueue = [],
            /** @type {!Array.<!Function>} sync request callbacks which should be called after the received ops have been applied server */
            uncalledSyncRequestCallbacksQueue = [],
            /** @type {!Array.<!function(!boolean):undefined>} ops created since the last sync call to the server */
            hasLocalUnsyncedOpsStateSubscribers = [],
            /**@type{!boolean}*/
            hasLocalUnsyncedOps = false,
            /**@type{!boolean} tells if any local ops have been modifying ops */
            hasPushedModificationOps = false,
            operationTransformer = new ops.OperationTransformer(),
            /**@const*/replayTime = 500,
            /**@const*/syncOpsDelay = 3000,
            /**@const*/idleDelay = 5000;


        function updateHasLocalUnsyncedOpsState() {
            var i,
                hasLocalUnsyncedOpsNow = (unsyncedClientOpspecQueue.length > 0);

            // no change?
            if (hasLocalUnsyncedOps === hasLocalUnsyncedOpsNow) {
                return;
            }

            hasLocalUnsyncedOps = hasLocalUnsyncedOpsNow;
            for (i=0; i<hasLocalUnsyncedOpsStateSubscribers.length; i+=1) {
                hasLocalUnsyncedOpsStateSubscribers[i](hasLocalUnsyncedOps);
            }
        }

        /**
         * @param {!Array.<!Object>} opspecs
         * @return {!Array.<!Object>}
         */
        function compressOpSpecs(opspecs) {
            var i, j, op,
                result = [];

            i = 0;
            while (i < opspecs.length) {
                // use factory to create an instance, and playback!
                op = operationFactory.create(opspecs[i]);
                // is known op and can do merge?
                if (op !== null && op.merge) {
                    // go over the following and try to merge them
                    for (j = i+1; j < opspecs.length; j += 1) {
                        if (!op.merge(opspecs[j])) {
                            break;
                        }
runtime.log("Merged: "+opspecs[i].optype+" with "+opspecs[j].optype);
                    }
                    // add the resulting op to the results
                    result.push(op.spec());
                    // and continue with the one which could not be merged, or behind end
                    i = j;
                } else {
                    // just pass on
                    result.push(opspecs[i]);
                    i += 1;
                }
            }
runtime.log("Merged: from "+opspecs.length+" to "+result.length+" specs");

            return result;
        }

        /**
         * @return {undefined}
         */
        function playUnplayedServerOpSpecs() {
            /**
             * @return {undefined}
             */
            function doPlayUnplayedServerOpSpecs() {
                var opspec, op, startTime, i;

                isPlayingUnplayedServerOpSpecs = false;

                // take start time
                startTime = (new Date()).getTime();

                // apply as much as possible in the given time
                while (unplayedServerOpspecQueue.length > 0) {
                    // time over?
                    if ((new Date().getTime()) - startTime > replayTime) {
                        break;
                    }

                    opspec = unplayedServerOpspecQueue.shift();

                    // use factory to create an instance, and playback!
                    op = operationFactory.create(opspec);
                    runtime.log(" op in: "+runtime.toJson(opspec));
                    if (op !== null) {
                        playbackFunction(op);
                    } else {
                        runtime.log("ignoring invalid incoming opspec: " + opspec);
                    }
                }

                // still unplayed opspecs?
                if (unplayedServerOpspecQueue.length > 0) {
                    // let other events be handled. then continue
                    isPlayingUnplayedServerOpSpecs = true;
                    runtime.getWindow().setTimeout(doPlayUnplayedServerOpSpecs, 1);
                } else {
                    // finally call all the callbacks waiting for that sync!
                    for (i = 0; i < uncalledSyncRequestCallbacksQueue.length; i += 1) {
                        uncalledSyncRequestCallbacksQueue[i]();
                    }

                    uncalledSyncRequestCallbacksQueue = [];
                }
            }

            if (isPlayingUnplayedServerOpSpecs) {
                return;
            }
            doPlayUnplayedServerOpSpecs();
        }

        /**
         * @param {Array.<!Object>} opspecs
         * @param {Array.<!Function>} callbacks
         * @return {undefined}
         */
        function receiveOpSpecsFromNetwork(opspecs, callbacks) {
            // append to existing unplayed
            unplayedServerOpspecQueue = unplayedServerOpspecQueue.concat(opspecs);
            uncalledSyncRequestCallbacksQueue = uncalledSyncRequestCallbacksQueue.concat(callbacks);
        }

        /**
         * Transforms the unsynced client ops and the server ops,
         * applies the server ops after transformation
         * @param {Array.<!Object>} serverOpspecs
         * @return {!boolean}
         */
        function handleOpsSyncConflict(serverOpspecs) {
            var i,
                transformResult;

            if (! serverOpspecs) {
                // TODO: proper error message, stop working
                runtime.assert(false, "no opspecs received!");
                return false;
            } // TODO: more checking of proper content in serverOpspecs

            transformResult = operationTransformer.transform(unsyncedClientOpspecQueue, /**@type{!Array.<!Object>}*/(serverOpspecs));

            if (!transformResult) {
                return false;
            }

            // store transformed server ops
            for (i = 0; i < transformResult.opsB.length; i += 1) {
                unplayedServerOpspecQueue.push(transformResult.opsB[i].spec());
            }

            // store opspecs of all transformed client opspecs
            unsyncedClientOpspecQueue = [];
            for (i = 0; i < transformResult.opsA.length; i += 1) {
                unsyncedClientOpspecQueue.push(transformResult.opsA[i].spec());
            }

            return true;
        }

        /**
         * @return {undefined}
         */
        function syncOps() {
            var syncedClientOpspecs,
                syncRequestCallbacksArray;

            /**
             * @return {undefined}
             */
            function startSyncOpsTimeout() {
                idleTimeout = null;
                syncOpsTimeout = runtime.getWindow().setTimeout(function() {
                    syncOpsTimeout = null;
                    syncOps();
                }, syncOpsDelay);
            }

            if (isSyncCallRunning || hasUnresolvableConflict) {
                return;
            }
            // TODO: hack, remove
            if (syncingBlocked) {
                return;
            }

runtime.log("OperationRouter: sending sync_ops call");
            // no more instant pull request in any case
            isInstantSyncRequested = false;
            // set lock
            isSyncCallRunning = true;

            // take specs from queue, if any
            syncedClientOpspecs = unsyncedClientOpspecQueue;
            unsyncedClientOpspecQueue = [];
            syncRequestCallbacksArray = syncRequestCallbacksQueue;
            syncRequestCallbacksQueue = [];

            server.call({
                command: 'sync_ops',
                args: {
                    es_id: sessionId,
                    member_id: memberId,
                    seq_head: String(lastServerSeq),
                    client_ops: syncedClientOpspecs
                }
            }, function(responseData) {
                var response = /** @type{{result:string, head_seq:string, ops:Array.<!Object>}} */(runtime.fromJson(responseData));

                // TODO: hack, remove
                if (syncingBlocked) {
                    return;
                }

                runtime.log("sync_ops reply: " + responseData);

                // just new ops?
                if (response.result === "new_ops") {
                    if (response.ops.length > 0) {
                        // no new locally in the meantime?
                        if (unsyncedClientOpspecQueue.length === 0) {
                            receiveOpSpecsFromNetwork(compressOpSpecs(response.ops), syncRequestCallbacksArray);
                        } else {
                            // transform server ops against new local ones and apply,
                            // transform and send new local ops to server
                            runtime.log("meh, have new ops locally meanwhile, have to do transformations.");
                            hasUnresolvableConflict = !handleOpsSyncConflict(compressOpSpecs(response.ops));
                            syncRequestCallbacksQueue = syncRequestCallbacksArray.concat(syncRequestCallbacksQueue);
                       }
                        // and note server state
                        lastServerSeq = response.head_seq;
                    } else {
                        receiveOpSpecsFromNetwork([], syncRequestCallbacksArray);
                    }
                } else if (response.result === "added") {
                    runtime.log("All added to server");
                    receiveOpSpecsFromNetwork([], syncRequestCallbacksArray);
                    // note server state
                    lastServerSeq = response.head_seq;
                    updateHasLocalUnsyncedOpsState();
                } else if (response.result === "conflict") {
                    // put the send ops back into the outgoing queue
                    unsyncedClientOpspecQueue = syncedClientOpspecs.concat(unsyncedClientOpspecQueue);
                    syncRequestCallbacksQueue = syncRequestCallbacksArray.concat(syncRequestCallbacksQueue);
                    // transform server ops against new local ones and apply,
                    // transform and request new send new local ops to server
                    runtime.log("meh, server has new ops meanwhile, have to do transformations.");
                    hasUnresolvableConflict = !handleOpsSyncConflict(compressOpSpecs(response.ops));
                    // and note server state
                    lastServerSeq = response.head_seq;
                    // try again instantly
                    if (!hasUnresolvableConflict) {
                        isInstantSyncRequested = true;
                    }
                } else {
                    runtime.assert(false, "Unexpected result on sync-ops call: "+response.result);
                }

                // unlock
                isSyncCallRunning = false;

                if (hasUnresolvableConflict) {
                    // TODO: offer option to reload session automatically?
                    runtime.assert(false,
                        "Sorry to tell:\n" +
                        "we hit a pair of operations in a state which yet need to be supported for transformation against each other.\n" +
                        "Client disconnected from session, no further editing accepted.\n\n" +
                        "Please reconnect manually for now.");
                } else {
                    // prepare next sync
                    if (isInstantSyncRequested) {
                        syncOps();
                    } else {
                        // nothing on client to sync?
                        if (unsyncedClientOpspecQueue.length === 0) {
                            idleTimeout = runtime.getWindow().setTimeout(startSyncOpsTimeout, idleDelay);
                        } else {
                            startSyncOpsTimeout();
                        }
                    }
                    playUnplayedServerOpSpecs();
                }
            });
        }

        function triggerPushingOps() {
            // disable any idle timeout
            if (idleTimeout) {
                runtime.clearTimeout(idleTimeout);
                idleTimeout = null;
            }

            // enable syncOps timeout, if needed
            if (!syncOpsTimeout && !isSyncCallRunning) {
runtime.log("OperationRouter: opsSync requested for pushing");
                syncOpsTimeout = runtime.getWindow().setTimeout(function() {
                    syncOpsTimeout = null;
                    syncOps();
                }, syncOpsDelay);
            }
        }

        /**
         * @param {!Funtion} cb
         * @return {undefined}
         */
        function requestInstantOpsSync(cb) {
            // register callback
            syncRequestCallbacksQueue.push(cb);

            // disable any idle timeout
            if (idleTimeout) {
                runtime.clearTimeout(idleTimeout);
                idleTimeout = null;
            }

            // disable any syncOps timeout
            if (syncOpsTimeout) {
                runtime.clearTimeout(syncOpsTimeout);
                syncOpsTimeout = null;
            }

runtime.log("OperationRouter: instant opsSync requested");
            isInstantSyncRequested = true;
            syncOps();
        };

        this.requestReplay = function (done_cb) {
            requestInstantOpsSync(done_cb);
        };

        /**
         * Sets the factory to use to create operation instances from operation specs.
         *
         * @param {!ops.OperationFactory} f
         * @return {undefined}
         */
        this.setOperationFactory = function (f) {
            operationFactory = f;
            operationTransformer.setOperationFactory(f);
        };

        /**
         * Sets the method which should be called to apply operations.
         *
         * @param {!function(!ops.Operation)} playback_func
         * @return {undefined}
         */
        this.setPlaybackFunction = function (playback_func) {
            playbackFunction = playback_func;
        };

        /**
         * Brings the locally created operations into the game.
         *
         * @param {!ops.Operation} op
         * @return {undefined}
         */
        this.push = function (op) {
            var timedOp,
                opspec = op.spec();

            if (hasUnresolvableConflict) {
                return;
            }
            // TODO: should be an assert in the future
            // there needs to be a flag telling that processing is happening,
            // and thus any input should be dropped in the sessioncontroller
            // ideally also have some UI element showing the processing state
            if (unplayedServerOpspecQueue.length > 0) {
                return;
            }

            // note if any local ops modified TODO: find less fragile way, perhaps have the operationFactory check it?
            hasPushedModificationOps = hasPushedModificationOps || !/^(AddCursor|MoveCursor|RemoveCursor)$/.test(opspec.optype);

            // apply locally
            opspec.timestamp = (new Date()).getTime();
            timedOp = operationFactory.create(opspec);

            playbackFunction(timedOp);

            // send to server
            unsyncedClientOpspecQueue.push(opspec);

            triggerPushingOps();

            updateHasLocalUnsyncedOpsState();
        };

        /**
         * Requests a gracefull shutdown of the Operation Router.
         * Buffered operations shall be sent to the server.
         * A callback is called on success.
         */
        this.close = function (cb) {
            function cbSuccess(fileData) {
                server.writeSessionStateToFile(sessionId, memberId, lastServerSeq, fileData, cb);
            }

            function doClose() {
                syncingBlocked = true;
                if (hasPushedModificationOps) {
                    odfContainer.createByteArray(cbSuccess, cb);
                } else {
                    cb();
                }
            }

            if (hasLocalUnsyncedOps) {
                requestInstantOpsSync(doClose);
            } else {
                doClose();
            }
        };

        this.getHasLocalUnsyncedOpsAndUpdates = function (subscriber) {
            var i;

            // detect double subscription
            for (i=0; i<hasLocalUnsyncedOpsStateSubscribers.length; i+=1) {
                if (subscribers[i] === subscriber) {
                    break;
                }
            }
            if (i < hasLocalUnsyncedOpsStateSubscribers.length) {
                // already subscribed
                runtime.log("double subscription request in PullBoxMemberModel::getHasLocalUnsyncedOpsAndUpdates");
            } else {
                // subscribe
                hasLocalUnsyncedOpsStateSubscribers.push(subscriber);
            }

            subscriber(hasLocalUnsyncedOps);
        };

        /*jslint emptyblock: true, unparam: true*/
        this.unsubscribeHasLocalUnsyncedOpsUpdates = function (subscriber) {
            var i;

            for (i=0; i<hasLocalUnsyncedOpsStateSubscribers.length; i+=1) {
                if (hasLocalUnsyncedOpsStateSubscribers[i] === subscriber) {
                    break;
                }
            }

            runtime.assert((i < hasLocalUnsyncedOpsStateSubscribers.length),
                            "tried to unsubscribe when not subscribed in PullBoxMemberModel::getHasLocalUnsyncedOpsAndUpdates");

            hasLocalUnsyncedOpsStateSubscribers.splice(i,1);
        };
    };
});
