Please update me when files in this folder change

Plugin invocation, permissions, events, and activity bridges.

| filename | role | function |
|---|---|---|
| Channel.kt | channel | Streams plugin responses to JavaScript |
| InvalidPluginMethodException.kt | error | Reports unknown reflected plugin methods |
| Invoke.kt | invoke | Carries one JavaScript plugin invocation |
| JSArray.kt | codec | Encodes JSON array values for the bridge |
| JSObject.kt | codec | Encodes JSON object values for the bridge |
| Plugin.kt | plugin | Defines the Android plugin base class |
| PluginHandle.kt | handle | Provides access to a registered plugin |
| PluginManager.kt | manager | Registers plugins and dispatches invocations |
| PluginMethodData.kt | type | Describes a reflected plugin method |
| PluginResult.kt | result | Carries plugin invocation results |
