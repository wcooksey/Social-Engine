import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.neuralnetics.socialengine',
  appName: 'Social Engine',
  webDir: 'dist/social-engine-mobile/browser',
  server: { hostname: 'localhost', androidScheme: 'https' },
  ios: { contentInset: 'never' },
};

export default config;
