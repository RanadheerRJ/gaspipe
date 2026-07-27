/* PumpLog — Firebase initialization (separate app instances for auth creation) */

import { initializeApp, getApps, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
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
  apiKey: 'AIzaSyAAnNivgnZAFNsYkBEYEqYkA1t1o2_8ets',
  authDomain: 'gass-13462.firebaseapp.com',
  projectId: 'gass-13462',
  storageBucket: 'gass-13462.firebasestorage.app',
  messagingSenderId: '882056009263',
  appId: '1:882056009263:web:5a15413cd2f2459825d8da',
  measurementId: 'G-G8SNH63CKY',
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

async function destroyAdminApp() {
  if (adminApp) {
    await deleteApp(adminApp);
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
