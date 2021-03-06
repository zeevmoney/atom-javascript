'use strict';

/**
 *
 * This class implements a tracker for tracking events to ironSource atom
 * @param {Object} params
 * @param {Number} [params.flushInterval=30 seconds] - Data sending interval
 * @param {Number} [params.bulkLen=20] - Number of records in each bulk request
 * @param {Number} [params.bulkSize=40KB] - The maximum bulk size in KB.
 *
 * Optional for ISAtom main object:
 * @param {String} [params.endpoint] - Endpoint api url
 * @param {String} [params.auth] - Key for hmac authentication
 * @constructor
 */
function Tracker(params) {
  var self = this;
  this.retryTimeout = 1000;
  params = params || {};
  this.params = params;
  this.params.flushInterval = params.flushInterval ? params.flushInterval * 1000 : 10000;
  this.params.bulkLen = params.bulkLen ? params.bulkLen : 3;
  this.params.bulkSize = params.bulkSize ? params.bulkSize * 1024 : 10 * 1024;
  this.params.auth = params.auth ? params.auth : ''; // Default auth for all streams

  // Dict of accumulated records: (stream -> [data array])
  this.accumulated = {};
  this.atom = new IronSourceAtom(params);

  //Flush everything every {flushInterval} seconds
  if (!this.timer) {
    this.timer = setInterval(function () {
      self.flush();
    }, this.params.flushInterval);
  }
}

window.IronSourceAtom.Tracker = Tracker;

/**
 * Atom Callback function
 * @callback trackerCallback
 * @param {Array} data - Array with responce from server: [{err,data,status}...]
 */

/**
 * Start tracking events to ironSource Atom
 * @param {String} stream - Atom stream name
 * @param {String|Object} data - data to be tracked to atom.
 *
 * @example
 * var options = {
 *    endpoint: "https://track.atom-data.io/",
 *    auth: "YOUR_HMAC_AUTH_KEY", // Optional, depends on your stream config
 *    flushInterval: 10, // Optional, Tracker flush interval in seconds (default: 30 seconds)
 *    bulkLen: 50, // Optional, Number of events per bulk (batch) (default: 20)
 *    bulkSize: 20 // Optional, Size of each bulk in KB (default: 40KB)
 * }
 *
 * var tracker = new IronSourceAtom.Tracker(options); // Init a new tracker
 * var stream = "MY_STREAM_NAME", // Your target stream name
 * var data = {id: 1, string_col: "String"} // Data that matches your DB structure
 * tracker.track(stream, data); // Start tracking and empty on the described above conditions
 *
 */

Tracker.prototype.track = function (stream, data) {
  var self = this;
  if (stream === undefined || stream.length == 0 || data.length == 0 || data === undefined) {
    throw new Error('Stream name and data are required parameters');
  }

  // Init the stream backlog (stream -> [data array])
  if (!(stream in self.accumulated)) {
    self.accumulated[stream] = [];
  }

  // Store the data as an array of strings
  if ((typeof data !== 'string' && !(data instanceof String))) {
    try {
      self.accumulated[stream].push(JSON.stringify(data))
    } catch (e) {
      /* istanbul ignore next */
      throw new Error("Invalid Data - can't be stringified", e);
    }
  } else {
    self.accumulated[stream].push(data);
  }

  // Flush on a certain bulk length or bulk size (in bytes)
  if (self.accumulated[stream].length >= self.params.bulkLen
    || _byteCount(self.accumulated[stream]) >= self.params.bulkSize) {
    self.flush(stream);
  }
};

/**
 * Flush accumulated events to ironSource Atom
 * @param {String} targetStream - atom stream name
 * @param {trackerCallback} callback - The callback that handles the response.
 *
 * @example
 *
 *  // To Flush all events:
 *  tracker.flush(null, function (results) {
 *    //returns an array of results, for example:
 *    //data is: {"a":[{key: "value"}],"b":[{key: "value"}]}
 *    //result: [{"err":"Auth Error: \"a\"","data":null,"status":401} ,{"err":null,"data":{"Status":"OK"},"status":200}]
 *    NOTE: the results will be in the same order as the data.
 *  }); // Send accumulated data immediately

 // If you don't need the results, just do:
 tracker.flush();
 // OR to flush a single stream (optional callback)
 tracker.flush(stream);
 */

Tracker.prototype.flush = function (targetStream, callback) {
  var self = this;
  var timeout = this.retryTimeout;

  if (!callback) {
    callback = function (err, data) {
      return err ? new Error(err) : data;
    };
  }

  var tasks = [];

  if (targetStream) {
    if (self.accumulated[targetStream].length >= 1) {
      tasks.push(function (taskCb) {
        _send(targetStream, self.accumulated[targetStream], timeout, taskCb, true);
      });
    }
  } else {
    for (var stream in self.accumulated) {
      if (self.accumulated[stream].length >= 1) {
        // The IIFE is here to create a separate scope so we don't get the stream as closure from the upper func.
        // DO NOT REMOVE IT unless you find a nicer way to copy the stream by value without jqeury/es6.
        (function (stream) {
          tasks.push(function (taskCb) {
            return _send(stream, self.accumulated[stream], timeout, taskCb, true);
          });
        })(stream);
      }
    }
  }
  return taskMap(tasks, callback);

  function _send(sendStream, sendData, timeout, callback, firstRun) {

    // In order to prevent the deletion of the data on each function call
    if (firstRun) {
      self.accumulated[sendStream] = [];
      firstRun = false;
    }

    // check return
    return self.atom.putEvents({"stream": sendStream, "data": sendData}, function (err, data, status) {
      if (err != null && status >= 500) {
        // Exponential back off + jitter - retry for 20 minutes max
        if (timeout < 20 * 60 * 1000) {
          setTimeout(function () {
            timeout = timeout * 2 + Math.floor((Math.random() * 1000) + 100);
            _send(sendStream, sendData, timeout, callback, firstRun);
          }, timeout);
          return;
        } else {
          // Case server didn't respond for too much time
          return callback('Timeout - No response from server', null, 408);
        }
      }
      return callback(err, data, status);
    })
  }
};

function _byteCount(string) {
  return encodeURI(string).split(/%..|./).length - 1;
}