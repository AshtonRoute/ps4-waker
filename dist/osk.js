'use strict';

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

var events = require('events'),
    EventEmitter = events.EventEmitter;

/**
 * Interface on top of the OnScreenKeyboard. You should normally
 *  not instantiate this yourself; it will be instantiated for you
 *  as a result of calling Device.getKeyboard().
 *
 * Emits the following events:
 *  - `close`: Someone (possibly us) closed the Keyboard.
 *      After this event is emitted, this instance becomes
 *      inactive, and all methods will throw an exception.
 */
class OnScreenKeyboard extends EventEmitter {

    constructor(device, state) {
        super();

        this.device = device;
        this.state = state;

        let log = device.opts.debug ? console.log.bind(console) // eslint-disable-line
        : () => {};

        let socket = device._socket;

        socket.on('osk_string_changed', packet => {
            log('OSK', packet);

            // TODO: can we use this for something cool?
            this._lastStringPacket = packet;
        });

        socket.once('osk_command', packet => {
            log('OSK COMMAND', packet.command);

            this._onClose();
        });
    }

    get isActive() {
        return this.state && this.state.status === 0;
    }

    /**
     * Set the current OSK text, optionally choosing a specific
     *  position for the caret. Resolves to this object.
     */
    setText(string, caretIndex = -1) {
        var _this = this;

        return _asyncToGenerator(function* () {
            _this._checkActive();

            let socket = yield _this._openSocket();
            socket.changeOskString({
                caretIndex: caretIndex === -1 ? string.length : caretIndex
            }, string);

            return _this;
        })();
    }

    /**
     * Close the keyboard. This instance will become
     *  unusable, isActive will return false, and all
     *  other method calls on this instance will fail
     */
    close() {
        var _this2 = this;

        return _asyncToGenerator(function* () {
            _this2._checkActive();
            _this2._onClose();

            let socket = yield _this2._openSocket();
            socket.sendOskCommand('close');
        })();
    }

    /**
     * "Submit" the text currently in the keyboard, like
     *  pressing the "return" key. This also has the effect
     *  of `close()`.
     */
    submit() {
        var _this3 = this;

        return _asyncToGenerator(function* () {
            _this3._checkActive();
            _this3._onClose();

            let socket = yield _this3._openSocket();
            socket.sendOskCommand('return');
        })();
    }

    _onClose() {
        this.state = null;
        this.emit('close');
    }

    _openSocket() {
        return this.device.openSocket();
    }

    _checkActive() {
        if (!this.isActive) {
            throw new Error("Cannot perform that action on an inactive keyboard");
        }
    }
}

module.exports = OnScreenKeyboard;