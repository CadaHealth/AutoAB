# Signing and notarising a release

Unsigned builds work, but macOS Gatekeeper refuses the first launch and the
user has to right-click → Open. Signing and notarising removes that.

## What is needed

An **Apple Developer Program** membership, and from it a **Developer ID
Application** certificate. This is not the same as the *Apple Development*
certificate that Xcode installs: that one is for running your own builds on
your own registered devices, and Gatekeeper rejects it on anyone else's Mac
exactly like an unsigned app.

Team ID for this project: `UW76474L52`.

### Creating the certificate

1. https://developer.apple.com/account/resources/certificates → **+**
2. Choose **Developer ID Application** (under *Software*, not *Development*).
3. Follow the CSR flow, download the `.cer`, double-click to import it into the
   login keychain.
4. Confirm it landed:

```sh
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Until that prints something, the release build cannot be signed.

## Credentials for notarisation

Notarisation runs only when credentials are present in the environment, which
is why an ordinary `npm run package:mac` is unaffected. Prefer an App Store
Connect API key over an Apple ID password:

```sh
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
```

The Apple ID alternative also works and needs an app-specific password from
appleid.apple.com, never the account password:

```sh
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
export APPLE_TEAM_ID=UW76474L52
```

## Building a signed release

```sh
cd electron-app
npm run package:mac:arm64      # identity is picked up from the keychain
```

Local builds that should stay unsigned:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac:arm64
```

## Expect this to be slow

The bundled Python runtime contains **323 Mach-O files** (220 of them `.so`
extensions in numpy, scipy, pandas and matplotlib). Every one is signed
individually, and `--timestamp` means every one is a round trip to Apple's
timestamp server. A signing attempt on a development certificate failed partway
through the scipy extensions with:

```
_shortest_path.cpython-311-darwin.so: A timestamp was expected but was not found
```

That is the timestamp service refusing or rate-limiting, not a certificate
problem. If it happens, re-run the build: signing is idempotent and the failure
is transient. Budget considerably more time than an unsigned build takes, and
avoid running releases over a flaky connection.

## Verifying the result

```sh
codesign -dv --verbose=4 release/mac-arm64/AutoAB.app 2>&1 | grep -E "Authority|TeamIdentifier"
spctl -a -vvv -t install release/mac-arm64/AutoAB.app
xcrun stapler validate release/mac-arm64/AutoAB.app
```

`spctl` should say `accepted` and `source=Notarized Developer ID`. Anything
else means the app will still be blocked on someone else's machine.
