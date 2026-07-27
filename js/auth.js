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
  writeBatch,
  auth as firebaseAuth,
  db as firebaseDb,
} from './firebase.js';

let currentUser = null;
let currentUserData = null;
let currentAuthError = null;
let authListeners = [];

function notifyAuthListeners() {
  authListeners.forEach(fn => fn(currentUser, currentUserData, currentAuthError));
}

// ── Initialize Firebase Auth ────────────────────────────────────────────
export function initAuth() {
  const { auth, db } = initMainApp(FIREBASE_CONFIG);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    currentAuthError = null;

    try {
      if (user) {
        currentUserData = await loadOrCreateUserProfile(user, db);
      } else {
        currentUserData = null;
      }
    } catch (err) {
      console.error('Auth/profile setup error:', err);
      currentUserData = null;
      currentAuthError = err;
      notifyAuthListeners();

      // If Auth succeeded but the Firestore profile could not be loaded/created,
      // sign out locally so the next Sign In click gets a fresh auth-state cycle.
      if (user && auth.currentUser?.uid === user.uid) {
        await signOut(auth).catch(() => {});
      }
      return;
    }

    notifyAuthListeners();
  });

  return { auth, db };
}

// ── Bootstrap / profile setup ───────────────────────────────────────────
async function loadOrCreateUserProfile(user, db) {
  const userRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userRef);

  if (userDoc.exists()) {
    return { uid: user.uid, ...userDoc.data() };
  }

  return checkBootstrapSuperAdmin(user, db, userRef);
}

async function checkBootstrapSuperAdmin(user, db, userRef) {
  // Static hosting has no server process, so PumpLog uses a Firestore
  // bootstrap marker. If app/bootstrap does not exist, this signup becomes
  // Super Admin and creates the marker in the same batch. Later public signups
  // become Staff with no station access until an admin assigns them.
  const bootstrapRef = doc(db, 'app', 'bootstrap');
  const bootstrapSnap = await getDoc(bootstrapRef);
  const isFirst = !bootstrapSnap.exists();

  const role = isFirst ? 'superadmin' : 'staff';
  const data = {
    email: user.email,
    role,
    stationIds: [],
    createdBy: isFirst ? user.uid : 'system',
    createdAt: serverTimestamp(),
  };

  if (isFirst) {
    const batch = writeBatch(db);
    batch.set(userRef, data);
    batch.set(bootstrapRef, {
      uid: user.uid,
      email: user.email,
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  } else {
    await setDoc(userRef, data);
  }

  return { ...data, uid: user.uid };
}

// ── Friendly Firebase errors ────────────────────────────────────────────
export function formatFirebaseError(err) {
  const code = err?.code || '';
  const raw = err?.message || '';

  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Tap “Already have an account? Sign In” and sign in instead.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/missing-password':
      return 'Please enter your password.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 6 characters.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect. Please check both and try again.';
    case 'auth/user-disabled':
      return 'This account has been disabled in Firebase Authentication.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your internet connection and try again.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is not enabled. In Firebase Console, enable Authentication → Sign-in method → Email/Password.';
    case 'permission-denied':
    case 'firestore/permission-denied':
      return 'Firebase created or signed in the account, but Firestore blocked PumpLog from loading the user profile. Publish the updated firestore.rules file in Firebase Console → Firestore Database → Rules, then sign in again.';
    case 'unavailable':
    case 'firestore/unavailable':
      return 'Firestore is temporarily unavailable. Please try again in a moment.';
    case 'failed-precondition':
    case 'firestore/failed-precondition':
      return 'Firestore needs an index or setup change for this action. Check the Firebase Console error details.';
    default:
      if (raw.includes('Missing or insufficient permissions')) {
        return 'Firestore permissions are blocking this action. Publish the updated firestore.rules file in Firebase Console → Firestore Database → Rules, then try again.';
      }
      return raw || 'Something went wrong. Please try again.';
  }
}

// ── Sign In ─────────────────────────────────────────────────────────────
export async function signIn(email, password) {
  return signInWithEmailAndPassword(firebaseAuth, email, password);
}

// ── Sign Up ─────────────────────────────────────────────────────────────
export async function signUp(email, password) {
  const cred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
  // The onAuthStateChanged handler creates/loads the Firestore profile.
  return cred;
}

// ── Sign Out ────────────────────────────────────────────────────────────
export async function doSignOut() {
  await signOut(firebaseAuth);
}

// ── Create User via Admin (without signing out current user) ────────────
export async function createUserAsAdmin(email, password, role, stationIds) {
  const admin = getAdminApp(FIREBASE_CONFIG);

  try {
    const cred = await createUserWithEmailAndPassword(admin.auth, email, password);

    // Write user document
    const userData = {
      email,
      role,
      stationIds: stationIds || [],
      createdBy: currentUser?.uid || 'unknown',
      createdAt: serverTimestamp(),
    };

    await setDoc(doc(firebaseDb, 'users', cred.user.uid), userData);
    return cred.user.uid;
  } finally {
    // Always clean up the isolated app so the current admin remains signed in
    // and the next attempt starts from a clean auth state.
    await signOut(admin.auth).catch(() => {});
    await destroyAdminApp().catch(() => {});
  }
}

// ── Get current state ───────────────────────────────────────────────────
export function getCurrentUser() { return currentUser; }
export function getCurrentUserData() { return currentUserData; }
export function getCurrentAuthError() { return currentAuthError; }

// ── Listen for auth changes ─────────────────────────────────────────────
export function onAuthChange(fn) {
  authListeners.push(fn);
  // If already logged in or an auth/profile error has happened, fire immediately
  if ((currentUser && currentUserData) || currentAuthError) {
    fn(currentUser, currentUserData, currentAuthError);
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
