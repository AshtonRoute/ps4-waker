'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

var events = require('events'),
    EventEmitter = events.EventEmitter,
    Detector = require('./detector'),
    OnScreenKeyboard = require('./osk'),
    Socket = require('./ps4socket'),
    Waker = require('./waker'),
    DEFAULT_TIMEOUT = 10000,
    POST_CONNECT_SENDKEY_DELAY = 1500,
    MIN_SENDKEY_DELAY = 200 // min delay between sendKey sends
,
    HOME = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || '',
    DEFAULT_CREDS = require('path').join(HOME, '.ps4-wake.credentials.json');

function delayMillis(millis) {
    return new Promise(resolve => {
        setTimeout(resolve.bind(resolve, true), millis);
    });
}

/**
 * Device is a high-level abstraction on top of a single
 *  PS4 device. It maintains a single, active connection
 *  to the device so repeated commands won't cause lots of
 *  annoying "connected" and "disconnected" messages to pop
 *  up on your device.
 *
 * Device is also an EventEmitter, and emits events from
 *  Waker and Socket.
 */
class Device extends EventEmitter {

    /**
     * Construct a new Device. Accepts an options map with
     *  the following keys:
     *
     * - address: (optional) IP address of a specific device.
     *            If omitted, will operate on the first device
     *            detected
     * - autoLogin: (default: true) If false, will skip logging
     *              into an account when waking the device.
     *              NOTE: if autoLogin is false, ONLY the following
     *              functions will work:
     *                  - turnOn()
     *                  - getDeviceStatus()
     *              Everything else will encounter errors!
     * - credentials: (optional) Path to a ps4-wake.credentials.json
     *                file to use. If not provided, uses one in the
     *                home directory of the current user.
     * - passCode: (optional) 4-digit string, if the account whose
     *             credentials we're using has set one
     * - timeout: How long network operations can be stalled before
     *            we give up on them and throw an error
     *
     * In addition, it respects the following keys from `detectOpts`,
     *  normally passed to Detector:
     *
     * - bindAddress: Address on which to bind the local udp detection
     *                socket, in case of multiple network interfaces.
     *                If omitted, will bind on the default interface.
     *                SEe dgram.Socket.bind() option `address`
     * - bindPort: Port on which to bind the local udp detection socket,
     *             in case you need to explicitly route. If omitted,
     *             will bind on any available port the system wishes
     *             to assign.
     */
    constructor(opts) {
        super();

        this.opts = _extends({
            autoLogin: true,
            credentials: DEFAULT_CREDS,
            passCode: "",
            timeout: DEFAULT_TIMEOUT,
            debug: false

        }, opts);

        if (!this.opts.credentials || !this.opts.credentials.length) {
            this.opts.credentials = DEFAULT_CREDS;
        }
        if (!this.opts.timeout && this.opts.timeout !== 0) {
            this.opts.timeout = DEFAULT_TIMEOUT;
        }

        this._retryDelay = 500;
        this._socket = null;
        this._osk = null;
        this._connectedAt = 0;
    }

    /**
     * @return True if we believe we currently have an
     *  active connection to the device.
     */
    get isConnected() {
        return !!this._socket;
    }

    /**
     * Immediately close any active connection to this Device
     */
    close() {
        if (this._socket) {
            this._socket.close();
        }
        this.__waker = null;
    }

    /**
     * Fetch the raw device status message from the device.
     *  If this device was detected, resolves to an object
     *  that looks like:
     *
     *  {
     *      status: "Standby",
     *      statusCode: "620",
     *      statusLine: "620 Server Standby",
     *      address: "192.168.2.3",
     *      device-discovery-protocol-version: "00020020",
     *      host-name: "My PS4",
     *      host-type: "PS4",
     *      port: "997",
     *      system-version: "04550011",
     *  }
     */
    getDeviceStatus() {
        var _this = this;

        return _asyncToGenerator(function* () {
            let result = yield _this._detect();
            return result.device;
        })();
    }

    /**
     * Get an active Socket instance connected to this device,
     *  turning the device on if necessary. This is a low-level
     *  method that probably won't be necessary for most users.
     */
    openSocket() {
        var _this2 = this;

        return _asyncToGenerator(function* () {
            return _this2._connect();
        })();
    }

    /**
     * Get an instance of OnScreenKeyboard, if it is possible to
     *  do so. If there is no text field on screen, this will
     *  reject with an error.
     */
    getKeyboard() {
        var _this3 = this;

        return _asyncToGenerator(function* () {
            if (_this3._osk) return _this3._osk;

            let socket = yield _this3.openSocket();

            return new Promise(function (resolve, reject) {
                socket.startOsk(function (err, packet) {
                    if (err) return reject(err);

                    let osk = new OnScreenKeyboard(_this3, packet);
                    osk.once('close', function () {
                        _this3._osk = null;
                    });

                    resolve(_this3._osk = osk);
                });
            });
        })();
    }

    /**
     * Send a sequence of remote key presses to this device,
     *  turning the device on if necessary. Resolves to this object.
     *  Key names are case insensitive, and can be one of:
     *
     *   up, down, left, right, enter, back, option, ps
     *
     * In addition, a key may instead be a tuple of [key, holdTime],
     *  where holdTime is an int indicating how long, in milliseconds,
     *  the key should be held for
     */
    sendKeys(keyNames) {
        var _arguments = arguments,
            _this4 = this;

        return _asyncToGenerator(function* () {
            // validate keys:
            if (!keyNames || !keyNames.length) {
                throw new Error("No keys provided");
            }

            if (_arguments.length !== 1 || !Array.isArray(keyNames)) {
                throw new Error("sendKeys must be called with an array");
            }

            keyNames = keyNames.map(function (key) {
                if (Array.isArray(key)) {
                    key[0] = key[0].toUpperCase();
                    return key;
                } else {
                    if (typeof key !== 'string') {
                        throw new Error("Invalid key: " + key + "; must be a string or a tuple");
                    }
                    return [key.toUpperCase(), 0];
                }
            });

            let invalid = keyNames.filter(function (key) {
                return !(key[0] in Socket.RCKeys);
            });
            if (invalid.length) {
                throw new Error("Unknown key names: " + invalid.map(function (key) {
                    return key[0];
                }));
            }

            let socket = yield _this4.openSocket();

            let msSinceConnect = Date.now() - _this4._connectedAt;
            let delay = POST_CONNECT_SENDKEY_DELAY - msSinceConnect;
            if (delay > 0) {
                // give it some time to think---if we try to OPEN_RC
                //  too soon after connecting, the ps4 seems to disregard
                yield delayMillis(delay);
            }

            socket.remoteControl(Socket.RCKeys.OPEN_RC);
            yield delayMillis(MIN_SENDKEY_DELAY);

            for (var i = 0; i < keyNames.length; ++i) {
                // near as I can tell, here's how this works:
                // - For a simple tap, you send the key with holdTime=0,
                //   followed by KEY_OFF and holdTime = 0
                // - For a long press/hold, you still send the key with
                //   holdTime=0, the follow it with the key again, but
                //   specifying holdTime as the hold duration.
                // - After sending a direction, you should send KEY_OFF
                //   to clean it up (since it can just be held forever).
                //   Doing this after a long-press of PS just breaks it,
                //   however.

                var _keyNames$i = _slicedToArray(keyNames[i], 2);

                const key = _keyNames$i[0],
                      holdTime = _keyNames$i[1];

                const val = Socket.RCKeys[key];
                socket.remoteControl(val, 0);

                if (holdTime) {
                    yield delayMillis(holdTime);
                    socket.remoteControl(val, holdTime);
                }

                // clean up the keypress. As mentioned above, after holding
                //  a direction, sending KEY_OFF seems to make further
                //  presses more reliable; doing that after holding PS button
                //  breaks it, however.
                if (!holdTime || val !== Socket.RCKeys.PS) {
                    socket.remoteControl(Socket.RCKeys.KEY_OFF, 0);
                }

                if (!key.endsWith('_RC')) {
                    _this4.emit('sent-key', key);
                }

                yield delayMillis(val === Socket.RCKeys.PS ? 1000 // higher delay after PS button press
                : MIN_SENDKEY_DELAY // too much lower and it becomes unreliable
                );
            }

            socket.remoteControl(Socket.RCKeys.CLOSE_RC);
            yield delayMillis(MIN_SENDKEY_DELAY);

            return _this4;
        })();
    }

    /**
     * Start running the application with the given ID on this
     *  device, turning the device on if necessary. Resolves
     *  to this object.
     */
    startTitle(titleId) {
        var _this5 = this;

        return _asyncToGenerator(function* () {
            let socket = yield _this5.openSocket();

            return new Promise(function (resolve, reject) {
                socket.startTitle(titleId, function (err) {
                    if (err) return reject(err);
                    resolve(_this5);
                });
            });
        })();
    }

    /**
     * Turn on this device, if it isn't already.
     *  Resolves to this object.
     */
    turnOn() {
        var _this6 = this;

        return _asyncToGenerator(function* () {
            yield _this6._connect();
            return _this6;
        })();
    }

    /**
     * Turn off this device (put it into standby)
     *  if it isn't already. Resolves to this object.
     */
    turnOff() /* _existingResolve */{
        var _this7 = this,
            _arguments2 = arguments;

        return _asyncToGenerator(function* () {
            let socket = yield _this7._connectIfAwake();
            if (!socket) {
                // it's already off
                return _this7;
            }

            let isRetry = _arguments2.length > 0;
            let doRequestStandby = function doRequestStandby(resolve, reject) {
                socket.requestStandby(function (err) {
                    if (err && isRetry) {
                        reject(err);
                    } else if (err) {
                        // error; disconnecting and retrying
                        socket.close();
                        _this7._onClose();

                        setTimeout(function () {
                            return _this7.turnOff(resolve, reject);
                        }, _this7._retryDelay);
                    } else {
                        resolve(_this7);
                    }
                });
            };

            if (isRetry) {
                // we were provided a (resolve, reject) pair from the
                // retry above.
                doRequestStandby(_arguments2[0], _arguments2[1]);
            } else {
                return new Promise(doRequestStandby);
            }
        })();
    }

    /**
     * If this device is awake, connect to it and
     *  resolve to the socket; otherwise, resolve
     *  to null.
     */
    _connectIfAwake() {
        var _this8 = this;

        return _asyncToGenerator(function* () {
            let isAwake = yield _this8._detectAwake();
            if (!isAwake) return null;

            return _this8._connect();
        })();
    }

    /**
     * Connect to this device, waking it if necessary;
     * @return the socket, or `undefined` if autoLogin is false
     */
    _connect() {
        var _this9 = this;

        return _asyncToGenerator(function* () {
            if (_this9._socket) return _this9._socket;

            // find the right device, if any
            let result = yield _this9._detect();

            return new Promise(function (resolve, reject) {
                _this9._waker().wake(_this9.opts, result.device, function (err, socket) {
                    if (err) return reject(err);
                    if (!_this9.opts.autoLogin) return resolve();
                    if (!socket) return reject(new Error("No socket"));

                    if (_this9._socket) {
                        // close existing socket
                        _this9._socket.close();
                        _this9._onClose();
                    }

                    // forward socket events:
                    socket.on('connected', function () {
                        _this9.emit('connected', _this9);
                    }).on('ready', function () {
                        _this9.emit('ready', _this9);
                    }).on('login_result', function (result) {
                        _this9.emit('login_result', result);
                    }).on('login_retry', function () {
                        _this9.emit('login_retry', _this9);
                    }).on('error', function (err) {
                        _this9.emit('error', err);
                    }).on('disconnected', function () {
                        _this9._onClose();
                        _this9.emit('disconnected', _this9);
                    });

                    _this9._socket = socket;
                    _this9._connectedAt = Date.now();
                    resolve(socket);

                    // checking socket.client is a hack to
                    //  confirm that we're already connected
                    if (socket.client) {
                        // in fact, if we have a socket here
                        //  it should be connected...
                        _this9.emit('connected', _this9);
                    }
                });
            });
        })();
    }

    /**
     * Returns a Promise that resolves to `true` if
     *  this device is awake, and `false` if not;
     *  rejects if the device could not be found.
     */
    _detectAwake() {
        var _this10 = this;

        return _asyncToGenerator(function* () {
            let result = yield _this10._detect();
            return result.device.status.toUpperCase() === 'OK';
        })();
    }

    /**
     * Detect any device that matches our this.opts.
     * Resolves to a map that looks like:
     *  {
     *      device: <see getDeviceStatus()>,
     *      rinfo: info
     *  }
     * TODO: more information please
     */
    _detect() {
        var _this11 = this;

        return _asyncToGenerator(function* () {
            return new Promise(function (resolve, reject) {
                // if the address opt was provided, detect that
                //  specific device. Otherwise, detect whatever
                let fn = _this11.opts.address ? Detector.find.bind(Detector, _this11.opts.address, _this11.opts, _this11.opts) : Detector.findAny.bind(Detector, _this11.opts, null);

                fn(function (err, device, rinfo) {
                    if (err) return reject(err);

                    // NOTE: we probably don't need to pass along rinfo...
                    device.address = rinfo.address;
                    device.port = device['host-request-port'];
                    resolve({ device: device, rinfo: rinfo });
                });
            });
        })();
    }

    _onClose() {
        this._socket = null;
        this._osk = null;
        this._connectedAt = 0;
    }

    /** Create a new Waker instance */
    _waker() {
        if (this.__waker) return this.__waker;
        return this.__waker = new Waker(this.opts.credentials, {
            autoLogin: this.opts.autoLogin,
            debug: this.opts.debug,
            errorIfAwake: false,
            keepSocket: true
        }).on('need-credentials', d => {
            this.emit('need-credentials', d);
        }).on('device-notified', d => {
            this.emit('device-notified', d);
        }).on('logging-in', d => {
            this.emit('logging-in', d);
        }).on('login_result', packet => {
            // yuck
            this.emit('login_result', packet);
        });
    }
}

module.exports = Device;