Please update me when files in this folder change

Regression tests for the reverse channel: the streams a device dials back for,
and the loopback ports on this server that they stand behind.

| filename | role | function |
|---|---|---|
| device-browser.test.ts | test | Covers acquire, verify, relaunch and reclaim for a browser on a device |
| device-chrome-commands.test.ts | test | Covers the launch and stop snippets per device platform |
| device-port.test.ts | test | Covers the handshake, byte transparency and teardown of a mapped device port |
| reverse-stream.test.ts | test | Covers stream pairing, expiry and device-disconnect cancellation |
