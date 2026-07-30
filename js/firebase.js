/* PumpLog — Firebase bootstrap
 *
 * Firestore is initialised with a persistent (IndexedDB) local cache so repeat
 * visits render from disk immediately instead of waiting on the network.
 */

import { initializeApp, getApps, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
  EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  collectionGroup,
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
  documentId,
  Timestamp,
  serverTimestamp,
  writeBatch,
  runTransaction,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ── Configuration ───────────────────────────────────────────────────────
// Replace with your own project config from Firebase Console →
// Project Settings → General → Your apps → Web.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAAnNivgnZAFNsYkBEYEqYkA1t1o2_8ets',
  authDomain: 'gass-13462.firebaseapp.com',
  projectId: 'gass-13462',
  storageBucket: 'gass-13462.firebasestorage.app',
  messagingSenderId: '882056009263',
  appId: '1:882056009263:web:5a15413cd2f2459825d8da',
  measurementId: 'G-G8SNH63CKY',
};

let mainApp = null;
let mainAuth = null;
let mainDb = null;

function initMainApp(config = FIREBASE_CONFIG) {
  if (mainApp) return { app: mainApp, auth: mainAuth, db: mainDb };

  mainApp = getApps().length ? getApps()[0] : initializeApp(config);
  mainAuth = getAuth(mainApp);
  // Explicit local persistence keeps staff signed in across app restarts and tab closes.
  setPersistence(mainAuth, browserLocalPersistence).catch(() => {});

  try {
    mainDb = initializeFirestore(mainApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    // Private browsing / unsupported storage — fall back to memory cache.
    mainDb = getFirestore(mainApp);
  }

  return { app: mainApp, auth: mainAuth, db: mainDb };
}

function getDb() {
  return mainDb || initMainApp().db;
}

function getAuthInstance() {
  return mainAuth || initMainApp().auth;
}

function setAuthPersistence(remember = true) {
  return setPersistence(getAuthInstance(), remember ? browserLocalPersistence : browserSessionPersistence);
}

// ── Secondary app: create users without signing the admin out ───────────
let adminApp = null;

function getAdminApp(config = FIREBASE_CONFIG) {
  if (!adminApp) {
    adminApp = initializeApp(config, `adminCreation-${Date.now()}`);
  }
  return { app: adminApp, auth: getAuth(adminApp) };
}

async function destroyAdminApp() {
  if (adminApp) {
    const app = adminApp;
    adminApp = null;
    await deleteApp(app).catch(() => {});
  }
}

export {
  FIREBASE_CONFIG,
  initMainApp,
  getDb,
  getAuthInstance,
  setAuthPersistence,
  getAdminApp,
  destroyAdminApp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
  EmailAuthProvider,
  collection,
  collectionGroup,
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
  documentId,
  Timestamp,
  serverTimestamp,
  writeBatch,
  runTransaction,
  onSnapshot,
};
