// =============================================================================
// AUTH — Firebase sign-in with email/password or Google
// =============================================================================
'use strict';

// The app works signed out; an account only unlocks party play and cloud save.
// Gate entry points with `requireAuth()`, never the inventory itself. Before
// `state.auth.ready` flips, "no user" means "not known yet".

let firebaseAuth = null;

// What to run once the user gets through the login modal, if anything.
let pendingAuthAction = null;

// 'signin' | 'signup' — one modal, two shapes.
let loginMode = 'signin';

// Starts Firebase Auth and listens for sign-in changes; a no-op without Firebase.
function initAuth() {
  if (!firebaseDb || typeof firebase === 'undefined' || !firebase.auth) return;

  try {
    firebaseAuth = firebase.auth();
  } catch (e) {
    console.warn('Firebase Auth unavailable — sign-in disabled:', e);
    return;
  }

  firebaseAuth.onAuthStateChanged(_handleAuthStateChange);
  _updateAuthUI();
}

// Every way in lands here — email, Google, a session restored at boot — so this
// is the only place that has to know what "now signed in" looks like.
function _handleAuthStateChange(user) {
  // The first answer is Firebase restoring (or not) a session at boot — the
  // boot already opened the home screen, and the reader may have left it since.
  const restoredAtBoot = !state.auth.ready;
  state.auth.user = user
    ? { uid: user.uid, email: user.email, displayName: user.displayName }
    : null;
  state.auth.ready = true;

  _updateAuthUI();
  renderHomeScreen();                  // the Campaigns section is gated on an account
  renderMissingScreen();               // its Sign in button, likewise
  renderChat();                        // who may speak just changed
  onAuthUserChanged(state.auth.user);  // cloud-save.js picks it up from here

  if (!user) return;

  // Unconditionally, or a Google sign-in leaves the modal up looking like it did nothing.
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

// Whether an account is signed in right now.
function isSignedIn() {
  return !!state.auth.user;
}

// Runs `action` once signed in, opening the login modal first if needed.
// `reason` is shown at the top of the modal so the prompt says what asked for it.
function requireAuth(reason, action) {
  if (!firebaseAuth) {
    // No account is possible here, so say what is actually missing rather than
    // showing a login box that cannot work.
    alert(firebaseDb
      ? 'Sign-in is unavailable because the Firebase Auth SDK did not load.\n\n' +
        'index.html pulls it from gstatic.com, so it needs a working network connection.'
      : getPartyUnavailableMessage());
    return;
  }
  if (isSignedIn()) { action(); return; }
  _openLoginModal(reason, action);
}

// ─── THE LOGIN MODAL ─────────────────────────────────────────────────────────
// `onSuccess` runs once they are through — always something visible, so signing
// in never reads as nothing having happened.
function _openLoginModal(reason, onSuccess = null) {
  pendingAuthAction = onSuccess;
  _setLoginMode('signin');
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-name').value = '';
  _showLoginError('');

  const reasonEl = document.getElementById('login-reason');
  reasonEl.textContent = reason || '';
  reasonEl.classList.toggle('hidden', !reason);

  showModal('login-modal');
  setTimeout(() => document.getElementById('login-email').focus(), 0);
}

function _setLoginMode(mode) {
  loginMode = mode === 'signup' ? 'signup' : 'signin';
  const isSignup = loginMode === 'signup';

  document.getElementById('login-title').textContent = isSignup ? 'Create Account' : 'Sign In';
  document.getElementById('login-submit-btn').textContent = isSignup ? 'Create Account' : 'Sign In';
  document.getElementById('login-toggle-mode').textContent = isSignup
    ? 'I already have an account'
    : 'Create an account';
  document.getElementById('login-password').autocomplete = isSignup ? 'new-password' : 'current-password';

  document.querySelectorAll('.auth-signup-only').forEach(el => el.classList.toggle('hidden', !isSignup));
  document.getElementById('login-reset-btn').classList.toggle('hidden', isSignup);
  _showLoginError('');
}

function _showLoginError(message, kind = 'error') {
  const el = document.getElementById('login-error');
  el.textContent = message;
  el.className = 'auth-error ' + kind + (message ? '' : ' hidden');
}

// Firebase's codes are precise but unreadable; these are the ones a user can hit.
function _getAuthErrorMessage(err) {
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

function _setLoginBusy(isBusy) {
  document.getElementById('login-submit-btn').disabled = isBusy;
  document.getElementById('google-signin-btn').disabled = isBusy;
}

async function _submitLoginForm() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const displayName = document.getElementById('login-name').value.trim();

  if (!email)    { _showLoginError('Enter your email address.'); return; }
  if (!password) { _showLoginError('Enter your password.'); return; }

  _setLoginBusy(true);
  _showLoginError('');
  try {
    if (loginMode === 'signup') {
      const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
      if (displayName && cred.user) {
        await cred.user.updateProfile({ displayName });
        // onAuthStateChanged has already fired with the profile-less user.
        state.auth.user = { uid: cred.user.uid, email: cred.user.email, displayName };
        _updateAuthUI();
      }
    } else {
      await firebaseAuth.signInWithEmailAndPassword(email, password);
    }
    // onAuthStateChanged closes the modal and runs whatever was pending.
  } catch (err) {
    _showLoginError(_getAuthErrorMessage(err));
  } finally {
    _setLoginBusy(false);
  }
}

async function _signInWithGoogle() {
  _setLoginBusy(true);
  _showLoginError('');
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebaseAuth.signInWithPopup(provider);
  } catch (err) {
    _showLoginError(_getAuthErrorMessage(err));
  } finally {
    _setLoginBusy(false);
  }
}

async function _sendPasswordReset() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { _showLoginError('Enter your email address first, then ask for a reset.'); return; }
  try {
    await firebaseAuth.sendPasswordResetEmail(email);
    _showLoginError('Reset email sent to ' + email + '.', 'notice');
  } catch (err) {
    _showLoginError(_getAuthErrorMessage(err));
  }
}

// Leaving the party first: staying in it while signed out would keep writing to
// a roster you no longer have an identity for.
async function _signOutUser() {
  if (!firebaseAuth) return;
  if (state.party.active) leaveParty();
  try {
    await firebaseAuth.signOut();
  } catch (err) {
    alert('Sign-out failed: ' + _getAuthErrorMessage(err));
  }
}

// ─── ACCOUNT UI (in Settings) ────────────────────────────────────────────────
// The signed-in user's name, falling back to their email's local part; '' when signed out.
function getAccountDisplayName() {
  const user = state.auth.user;
  if (!user) return '';
  return user.displayName || (user.email ? user.email.split('@')[0] : 'Signed in');
}

function _updateAuthUI() {
  const row = document.getElementById('account-row');
  if (!row) return;

  // No Firebase on this deploy — an account would have nothing to talk to.
  row.classList.toggle('hidden', !firebaseAuth);
  if (!firebaseAuth) return;

  const isUserSignedIn = isSignedIn();
  document.getElementById('account-signed-out').classList.toggle('hidden', isUserSignedIn);
  document.getElementById('account-signed-in').classList.toggle('hidden', !isUserSignedIn);

  if (isUserSignedIn) {
    document.getElementById('account-name').textContent  = getAccountDisplayName();
    document.getElementById('account-email').textContent = state.auth.user.email || '';
  }
  updateCloudStatusUI();
}

// ─── EVENT WIRING ────────────────────────────────────────────────────────────
document.getElementById('login-submit-btn').addEventListener('click', _submitLoginForm);
document.getElementById('google-signin-btn').addEventListener('click', _signInWithGoogle);
document.getElementById('login-reset-btn').addEventListener('click', _sendPasswordReset);
document.getElementById('login-toggle-mode').addEventListener('click', () => {
  _setLoginMode(loginMode === 'signup' ? 'signin' : 'signup');
});

// Enter submits from any of the fields, as a login form should.
document.querySelectorAll('#login-modal input').forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _submitLoginForm(); }
  });
});

// Cancelling abandons whatever the sign-in was for — otherwise it would fire
// unannounced the next time the user signed in for something else entirely.
document.querySelectorAll('#login-modal .cancel-btn').forEach(btn => {
  btn.addEventListener('click', () => { pendingAuthAction = null; });
});

// The no-op (not null) keeps the reader where they were; with nothing pending,
// _handleAuthStateChange() would send them home instead.
document.getElementById('account-signin-btn').addEventListener('click', () => {
  hideModal('settings-modal');
  _openLoginModal('Sign in to sync this inventory to your account.', () => {});
});

document.getElementById('account-signout-btn').addEventListener('click', () => {
  if (confirm('Sign out? Your inventory stays in this browser.')) _signOutUser();
});
