const { expo } = require("./app.json");

const androidUsesCleartextTraffic = process.env.RIPPLE_ANDROID_USES_CLEARTEXT === "true";

module.exports = () => ({
  ...expo,
  android: {
    ...expo.android,
    package: expo.android?.package ?? "com.lake.ripple.mobile",
  },
  plugins: [
    ...(expo.plugins ?? []),
    [
      "expo-build-properties",
      {
        android: {
          usesCleartextTraffic: androidUsesCleartextTraffic,
        },
      },
    ],
  ],
  extra: {
    ...expo.extra,
    ripple: {
      ...(expo.extra?.ripple ?? {}),
      androidUsesCleartextTraffic,
    },
  },
});
