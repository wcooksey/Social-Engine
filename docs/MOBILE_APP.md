# Social Engine mobile app

The Capacitor 8 projects bundle the Angular interface for iOS and Android.
They use the existing backend at https://app.neuralneticsai.com. Sending,
verification, pacing, and reply handling remain server-side and continue when
the app is closed. No provider keys belong in the mobile bundle.

## Build and open

Use Node 22 or newer. From `frontend`:

```sh
npm ci
npm run mobile:ios
# or
npm run mobile:android
```

These commands build the mobile configuration, copy assets and sync plugins,
then open Xcode or Android Studio. Run `npm run mobile:sync` after frontend
changes. Regular `npm run build` still produces the website in its original
output directory; mobile assets use a separate directory.

App ID: `com.neuralnetics.socialengine`. Display name: `Social Engine`.
Change both before registering a different identity for store distribution.
iOS uses Swift Package Manager and requires Xcode 26+. Android requires Android
Studio 2025.2.1+ and the SDK requested by the generated Gradle project.

## Deployment and device checks

- Deploy the backend CORS change before testing the installed app against
  production. It permits exactly `capacitor://localhost` (iOS) and
  `https://localhost` (Android), alongside configured origins; all private API
  calls still require authentication.
- Sign in with an existing account and check session restoration, logout, the
  inbox, draft actions, Engine streaming, and Android back navigation.
- Gmail connection opens the system browser. Complete consent, close the browser,
  and refresh Sending to see the connected account. Automatic return deep links
  are not configured yet.
- Test keyboard resizing, notch/home-indicator spacing, and microphone permission
  on physical devices. Microphone usage is declared for the existing voice UI.
- Use owned test contacts for send/reply/unsubscribe validation; installing or
  opening the app does not itself approve campaign drafts.

## Distribution still required

Select an Apple signing team in Xcode for a physical iPhone/TestFlight build.
Configure Android release signing for Play distribution. The generated icons and
splash screens are placeholders. Push notifications, secure native token storage,
offline data, automatic OAuth return links, and store submission are separate
work; this initial shell retains the web app's local session storage. Android
backup is disabled so app session data is not included in device backups.

## Validation on this workspace

The backend TypeScript build, production website build, mobile Angular build,
and Capacitor sync for both platforms passed. The iOS simulator build was
stopped while Xcode waited for Swift package binary downloads; native compilation
and launch are not yet verified. Android Studio/SDK is not installed here.
Production login from the native origins still needs testing after deploying the
backend change. Speech recognition support varies by WebView; microphone
declarations alone do not establish native voice support.

References: https://capacitorjs.com/docs/getting-started/environment-setup and
https://capacitorjs.com/docs/basics/workflow.
