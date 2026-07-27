/* PumpLog — Firebase initialization (separate app instances for auth creation) */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  setDoc,
  Timestamp,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ── Firebase Configuration ──────────────────────────────────────────────
// Replace this object with your own Firebase project config from
// https://console.firebase.google.com → Project Settings → General → Your apps → Web
const FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

// ── Init main app ───────────────────────────────────────────────────────
let mainApp;
let mainAuth;
let mainDb;

function initMainApp(config) {
  if (!getApps().length) {
    mainApp = initializeApp(config);
  } else {
    mainApp = getApps()[0];
  }
  mainAuth = getAuth(mainApp);
  mainDb = getFirestore(mainApp);
  return { app: mainApp, auth: mainAuth, db: mainDb };
}

// ── Second anonymous app (for admin user creation without signing out) ──
let adminApp = null;
let adminAuth = null;
let adminDb = null;

function getAdminApp(config) {
  if (!adminApp) {
    adminApp = initializeApp(config, 'adminCreation');
    adminAuth = getAuth(adminApp);
    adminDb = getFirestore(adminApp);
  }
  return { app: adminApp, auth: adminAuth, db: adminDb };
}

function destroyAdminApp() {
  if (adminApp) {
    adminApp.delete();
    adminApp = null;
    adminAuth = null;
    adminDb = null;
  }
}

// ── Exports ─────────────────────────────────────────────────────────────
export {
  FIREBASE_CONFIG,
  initMainApp,
  getAdminApp,
  destroyAdminApp,
  mainApp, mainAuth, mainDb,
  mainAuth as auth, mainDb as db,
  adminApp, adminAuth, adminDb,
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  setDoc,
  Timestamp,
  serverTimestamp,
  writeBatch,
};
