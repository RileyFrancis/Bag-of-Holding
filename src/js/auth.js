// =============================================================================
// AUTH — Firebase sign-in with email/password or Google
// =============================================================================
'use strict';

// The app works signed out, on localStorage. An account only unlocks party play
// and cloud save. Every gated entry point goes through `requireAuth(reason,
// action)`; do not gate the inventory itself. Firebase restores a session
// asynchronously — hence `state.auth.ready`; before it flips, "no user" means
// "not known yet". See CLAUDE.md § Accounts and cloud save.

let firebaseAuth = null;

// What to run once the user gets through the login modal, if anything.
let pendingAuthAction = null;

// 'signin' | 'signup' — one modal, two shapes.
let loginMode = 'signin';

function initAuth() {
  if (!firebaseDb || typeof firebase === 'undefined' || !firebase.auth) return;

  try {
    firebaseAuth = firebase.auth();
  } catch (e) {
    console.warn('Firebase Auth unavailable — sign-in disabled:', e);
    return;
  }

  firebaseAuth.onAuthStateChanged(handleAuthStateChange);

  updateAuthUI();
}

// Every way in lands here — email, Google, a session restored at boot — so this
// is the only place that has to know what "now signed in" looks like.
function handleAuthStateChange(user) {
  // The first answer is Firebase restoring (or not) a session at boot — the
  // boot already opened the home screen, and the reader may have left it since.
  const restoredAtBoot = !state.auth.ready;
  state.auth.user = user
    ? { uid: user.uid, email: user.email, displayName: user.displayName }
    : null;
  state.auth.ready = true;

  updateAuthUI();
  renderHomeScreen();                  // the Campaigns section is gated on an account
  renderMissingScreen();               // its Sign in button, likewise
  renderChat();                        // who may speak just changed
  onAuthUserChanged(state.auth.user);  // cloud-save.js picks it up from here

  if (!user) return;

  // Unconditionally — a Google sign-in that left the modal up looked like it
  // had done nothing.
  hideModal('login-modal');

  // Whatever the sign-in was for — the party modal, or back to Settings.
  if (pendingAuthAction) {
    const action = pendingAuthAction;
    pendingAuthAction = null;
    action();
    return;
  }

  // Nothing was waiting on it: an account means a roster, and the roster is
  // where a player starts.
  if (!restoredAtBoot) openHomeScreen();
}

function isSignedIn() {
  return !!state.auth.user;
}

// The one gate. `reason` is shown at the top of the login modal so the prompt
// never arrives without saying what asked for it.
function requireAuth(reason, action) {
  if (!firebaseAuth) {
    // No account is possible here, so say what is actually missing rather than
    // showing a login box that cannot work.
    alert(firebaseDb
      ? 'Sign-in is unavailable because the Firebase Auth SDK did not load.\n\n' +
        'index.html pulls it from gstatic.com, so it needs a working network connection.'
      : partyUnavailableMessage());
    return;
  }
  if (isSignedIn()) { action(); return; }
  openLoginModal(reason, action);
}

// =============================================================================
// THE LOGIN MODAL
// =============================================================================
// `onSuccess` runs once they are through — always something visible, so signing
// in never reads as nothing having happened.
function openLoginModal(reason, onSuccess = null) {
  pendingAuthAction = onSuccess;
  setLoginMode('signin');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-name').value = '';
  showLoginError('');

  const reasonEl = document.getElementById('login-reason');
  reasonEl.textContent = reason || '';
  reasonEl.classList.toggle('hidden', !reason);

  showModal('login-modal');
  setTimeout(() => document.getElementById('login-email').focus(), 0);
}

function setLoginMode(mode) {
  loginMode = mode === 'signup' ? 'signup' : 'signin';
  const signup = loginMode === 'signup';

  document.getElementById('login-title').textContent = signup ? 'Create Account' : 'Sign In';
  document.getElementById('login-submit-btn').textContent = signup ? 'Create Account' : 'Sign In';
  document.getElementById('login-toggle-mode').textContent = signup
    ? 'I already have an account'
    : 'Create an account';
  document.getElementById('login-password').autocomplete = signup ? 'new-password' : 'current-password';

  document.querySelectorAll('.auth-signup-only').forEach(el => el.classList.toggle('hidden', !signup));
  document.getElementById('login-reset-btn').classList.toggle('hidden', signup);
  showLoginError('');
}

function showLoginError(message, kind = 'error') {
  const el = document.getElementById('login-error');
  el.textContent = message;
  el.className = 'auth-error ' + kind + (message ? '' : ' hidden');
}

// Firebase's codes are precise but unreadable; these are the ones a user can hit.
function authErrorMessage(err) {
  switch (err && err.code) {
    case 'auth/invalid-email':           return 'That does not look like an email address.';
    case 'auth/missing-password':        return 'Enter your password.';
    case 'auth/weak-password':           return 'Password needs to be at least 6 characters.';
    case 'auth/email-already-in-use':    return 'That email already has an account — sign in instead.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials': return 'Wrong email or password.';
    case 'auth/configuration-not-found':   return 'This Firebase project has no Authentication enabled yet. ' +
                                                  'Open Firebase Console → Authentication → Get started, ' +
                                                  'then switch on Email/Password and Google.';
    case 'auth/too-many-requests':       return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed':  return 'No connection to Firebase. Check your network.';
    case 'auth/popup-closed-by-user':    return 'Google sign-in was closed before it finished.';
    case 'auth/popup-blocked':           return 'Your browser blocked the Google popup. Allow popups for this site and try again.';
    case 'auth/unauthorized-domain':     return 'This site is not an authorised domain for your Firebase project. ' +
                                                 'Add it under Authentication → Settings → Authorized domains.';
    case 'auth/operation-not-allowed':   return 'That sign-in method is switched off in your Firebase project. ' +
                                                 'Enable it under Authentication → Sign-in method.';
    default:                             return (err && err.message) || 'Sign-in failed.';
  }
}

function setLoginBusy(busy) {
  document.getElementById('login-submit-btn').disabled = busy;
  document.getElementById('google-signin-btn').disabled = busy;
}

async function submitLoginForm() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const displayName = document.getElementById('login-name').value.trim();

  if (!email)    { showLoginError('Enter your email address.'); return; }
  if (!password) { showLoginError('Enter your password.'); return; }

  setLoginBusy(true);
  showLoginError('');
  try {
    if (loginMode === 'signup') {
      const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
      if (displayName && cred.user) {
        await cred.user.updateProfile({ displayName });
        // onAuthStateChanged has already fired with the profile-less user.
        state.auth.user = { uid: cred.user.uid, email: cred.user.email, displayName };
        updateAuthUI();
      }
    } else {
      await firebaseAuth.signInWithEmailAndPassword(email, password);
    }
    // onAuthStateChanged closes the modal and runs whatever was pending.
  } catch (err) {
    showLoginError(authErrorMessage(err));
  } finally {
    setLoginBusy(false);
  }
}

async function signInWithGoogle() {
  setLoginBusy(true);
  showLoginError('');
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebaseAuth.signInWithPopup(provider);
  } catch (err) {
    showLoginError(authErrorMessage(err));
  } finally {
    setLoginBusy(false);
  }
}

async function sendPasswordReset() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { showLoginError('Enter your email address first, then ask for a reset.'); return; }
  try {
    await firebaseAuth.sendPasswordResetEmail(email);
    showLoginError('Reset email sent to ' + email + '.', 'notice');
  } catch (err) {
    showLoginError(authErrorMessage(err));
  }
}

// Leaving the party first: staying in it while signed out would keep writing to
// a roster you no longer have an identity for.
async function signOutUser() {
  if (!firebaseAuth) return;
  if (state.party.active) leaveParty();
  try {
    await firebaseAuth.signOut();
  } catch (err) {
    alert('Sign-out failed: ' + authErrorMessage(err));
  }
}

// =============================================================================
// ACCOUNT UI (in Settings)
// =============================================================================
function accountDisplayName() {
  const u = state.auth.user;
  if (!u) return '';
  return u.displayName || (u.email ? u.email.split('@')[0] : 'Signed in');
}

function updateAuthUI() {
  const row = document.getElementById('account-row');
  if (!row) return;

  // No Firebase on this deploy — an account would have nothing to talk to.
  row.classList.toggle('hidden', !firebaseAuth);
  if (!firebaseAuth) return;

  const signedIn = isSignedIn();
  document.getElementById('account-signed-out').classList.toggle('hidden', signedIn);
  document.getElementById('account-signed-in').classList.toggle('hidden', !signedIn);

  if (signedIn) {
    document.getElementById('account-name').textContent  = accountDisplayName();
    document.getElementById('account-email').textContent = state.auth.user.email || '';
  }
  updateCloudStatusUI();
}

// =============================================================================
// EVENT WIRING
// =============================================================================
document.getElementById('login-submit-btn').addEventListener('click', submitLoginForm);
document.getElementById('google-signin-btn').addEventListener('click', signInWithGoogle);
document.getElementById('login-reset-btn').addEventListener('click', sendPasswordReset);
document.getElementById('login-toggle-mode').addEventListener('click', () => {
  setLoginMode(loginMode === 'signup' ? 'signin' : 'signup');
});

// Enter submits from any of the fields, as a login form should.
document.querySelectorAll('#login-modal input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitLoginForm(); }
  });
});

// Cancelling abandons whatever the sign-in was for — otherwise it would fire
// unannounced the next time the user signed in for something else entirely.
document.querySelectorAll('#login-modal .cancel-btn').forEach(btn => {
  btn.addEventListener('click', () => { pendingAuthAction = null; });
});

// Settings stays closed afterwards — the sign-in is done, so there is nothing
// left to do there. The no-op (not null) keeps the reader where they were;
// with nothing pending, handleAuthStateChange() would send them home instead.
document.getElementById('account-signin-btn').addEventListener('click', () => {
  hideModal('settings-modal');
  openLoginModal('Sign in to sync this inventory to your account.', () => {});
});

document.getElementById('account-signout-btn').addEventListener('click', () => {
  if (confirm('Sign out? Your inventory stays in this browser.')) signOutUser();
});
