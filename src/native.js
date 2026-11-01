// Bundled into www/native.js so the plain-JS app can call Capacitor plugins.
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

window.Native = { Capacitor, Preferences, Filesystem, Directory, Encoding, Share, App };
