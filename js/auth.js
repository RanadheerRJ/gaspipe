/* PumpLog — Authentication module */

import {
  FIREBASE_CONFIG,
  initMainApp,
  getAdminApp,
  destroyAdminApp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from './firebase.js';

let currentUser = null;
let currentUserData = null;
let authListeners = [];

// ── Initialize Firebase Auth ────────────────────────────────────────────
export function initAuth() {
  const { auth, db } = initMainApp(FIREBASE_CONFIG);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      // Fetch user document from Firestore
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (userDoc.exists()) {
        currentUserData = userDoc.data();
        currentUserData.uid = user.uid;
      } else {
        // New user — check if this is the bootstrap Super Admin
        const isBootstrap = await checkBootstrapSuperAdmin(user, db);
        if (!isBootstrap) {
          // Shouldn't happen, but handle gracefully
          currentUserData = { email: user.email, role: 'staff', stationIds: [] };
        }
      }
    } else {
      currentUserData = null;
    }
    // Notify all listeners
    authListeners.forEach(fn => fn(currentUser, currentUserData));
  });

  return { auth, db };
}

// ── Bootstrap Super Admin ───────────────────────────────────────────────
async function checkBootstrapSuperAdmin(user, db) {
  // The first user to sign up becomes Super Admin
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) return true;

  // Check if any Super Admin exists already
  const admins = await getDocs(query(collection(db, 'users'), where('role', '==', 'superadmin')));
  const isFirst = admins.empty;

  const role = isFirst ? 'superadmin' : 'staff';
  const data = {
    email: user.email,
    role,
    stationIds: [],
    createdBy: isFirst ? user.uid : 'system',
    createdAt: serverTimestamp(),
  };

  await setDoc(userRef, data);
  currentUserData = { ...data, uid: user.uid };
  return true;
}

// ── Sign In ─────────────────────────────────────────────────────────────
export async function signIn(email, password) {
  const { auth } = await import('./firebase.js');
  return signInWithEmailAndPassword(auth, email, password);
}

// ── Sign Up ─────────────────────────────────────────────────────────────
export async function signUp(email, password) {
  const { auth, db } = await import('./firebase.js');
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  // The onAuthStateChanged handler will create the user doc via bootstrap check
  return cred;
}

// ── Sign Out ────────────────────────────────────────────────────────────
export async function doSignOut() {
  const { auth } = await import('./firebase.js');
  await signOut(auth);
}

// ── Create User via Admin (without signing out current user) ────────────
export async function createUserAsAdmin(email, password, role, stationIds) {
  const admin = getAdminApp(FIREBASE_CONFIG);
  const cred = await createUserWithEmailAndPassword(admin.auth, email, password);

  // Write user document
  const userData = {
    email,
    role,
    stationIds: stationIds || [],
    createdBy: currentUser?.uid || 'unknown',
    createdAt: serverTimestamp(),
  };

  const { db } = await import('./firebase.js');
  await setDoc(doc(db, 'users', cred.user.uid), userData);

  // Sign out of the admin instance
  await signOut(admin.auth);
  destroyAdminApp();

  return cred.user.uid;
}

// ── Get current state ───────────────────────────────────────────────────
export function getCurrentUser() { return currentUser; }
export function getCurrentUserData() { return currentUserData; }

// ── Listen for auth changes ─────────────────────────────────────────────
export function onAuthChange(fn) {
  authListeners.push(fn);
  // If already logged in, fire immediately
  if (currentUser && currentUserData) {
    fn(currentUser, currentUserData);
  }
  // Return unsubscribe function
  return () => {
    authListeners = authListeners.filter(f => f !== fn);
  };
}

export function hasRole(...roles) {
  return currentUserData && roles.includes(currentUserData.role);
}

export function isSuperAdmin() {
  return currentUserData?.role === 'superadmin';
}

export function isStationAdmin() {
  return currentUserData?.role === 'stationadmin';
}

export function isStaff() {
  return currentUserData?.role === 'staff';
}
