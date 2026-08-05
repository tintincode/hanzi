// js/profiles.js
// ProfileManager: multiple local learner profiles on one device/browser
// (e.g. two family members sharing a computer). Each profile gets its own
// practice history and bookmarks, namespaced via StorageManager/
// BookmarkManager's setProfile() — see those modules for the actual
// per-key storage mechanics. This module owns the profile list itself
// (hanziStudyProfiles.v1) plus the profile-panel UI.
//
// Deliberately NOT per-profile: theme (light/dark/auto) and compact-mode.
// Those are device/display preferences, not learner data — profiles
// switching them out from under you every time you change who's using
// the device would be surprising, not helpful.

import { StorageManager } from './storage.js';
import { BookmarkManager } from './bookmarks.js';
import { HistoryManager } from './history.js';
import { Templates } from './templates.js';

const PROFILES_KEY = 'hanziStudyProfiles.v1';
// Same base strings StorageManager/BookmarkManager build their own
// per-profile keys from (hanziStudyHistory.v1.<id>, hanziStudyBookmarks.
// v1.<id>) — duplicated here rather than imported, since this module's
// only use for them is the one-time legacy-data migration below and the
// cleanup step in deleteProfile(); it has no reason to otherwise know or
// care how those modules build their keys.
const HISTORY_KEY_BASE = 'hanziStudyHistory.v1';
const BOOKMARKS_KEY_BASE = 'hanziStudyBookmarks.v1';

// Standalone and deliberately `this`-free, matching history.js's own
// escapeHtml (module-private there too, not imported from here) —
// renderProfilePanelList() passes this around as a bare function
// reference into Templates.profileCard(), which would silently lose a
// `this` binding if this were a method instead.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const ProfileManager = {
  app: null,
  state: {
    activeProfileId: null,
    profiles: [] // [{ id, name, createdAt }]
  },

  init(app) {
    this.app = app;
    this.load();
    // Points StorageManager/BookmarkManager at the resolved profile
    // before anything else (HistoryManager.init(), etc.) reads through
    // them — see HanziApp.init()'s comment on why this has to run first.
    this.activateProfile(this.state.activeProfileId);
  },

  load() {
    try {
      const raw = localStorage.getItem(PROFILES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
          this.state.profiles = parsed.profiles;
          this.state.activeProfileId = parsed.profiles.some(p => p.id === parsed.activeProfileId)
            ? parsed.activeProfileId
            : parsed.profiles[0].id;
          return;
        }
      }
    } catch (e) {
      console.warn('ProfileManager: failed to load profiles, starting fresh.', e);
    }
    // No valid profile list on disk — either a genuinely fresh install,
    // or (more likely, for anyone who used the app before profiles
    // existed) data sitting under the old un-prefixed keys. Either way,
    // resolve into a single starter profile rather than requiring
    // "create your first profile" as an extra first-run step.
    this.createInitialProfile();
  },

  createInitialProfile() {
    const id = this.generateId();
    let hasLegacyData = false;
    try {
      hasLegacyData = !!(localStorage.getItem(HISTORY_KEY_BASE) || localStorage.getItem(BOOKMARKS_KEY_BASE));
    } catch (e) {
      // localStorage unavailable — nothing to migrate either way.
    }
    this.state.profiles = [{ id, name: '我的资料', createdAt: Date.now() }];
    this.state.activeProfileId = id;
    this.save();

    if (hasLegacyData) {
      // Copy the raw pre-profile values as-is into this profile's
      // namespaced keys, so nobody's existing history/bookmarks silently
      // vanish the first time this ships. StorageManager/BookmarkManager
      // don't need to know this migration happened — from here on they
      // just read the new namespaced key normally. The old un-prefixed
      // keys are deliberately left in place rather than deleted: if
      // anything here goes wrong, no data was destroyed, just not (yet)
      // copied over.
      try {
        const legacyHistory = localStorage.getItem(HISTORY_KEY_BASE);
        if (legacyHistory) localStorage.setItem(`${HISTORY_KEY_BASE}.${id}`, legacyHistory);
        const legacyBookmarks = localStorage.getItem(BOOKMARKS_KEY_BASE);
        if (legacyBookmarks) localStorage.setItem(`${BOOKMARKS_KEY_BASE}.${id}`, legacyBookmarks);
      } catch (e) {
        console.warn('ProfileManager: failed to migrate pre-profile data.', e);
      }
    }
  },

  generateId() {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  },

  save() {
    try {
      localStorage.setItem(PROFILES_KEY, JSON.stringify({
        version: 1,
        activeProfileId: this.state.activeProfileId,
        profiles: this.state.profiles
      }));
    } catch (e) {
      console.error('ProfileManager: failed to save profiles.', e);
    }
  },

  // Points StorageManager/BookmarkManager at `id` and has them (re)load
  // that profile's data into memory. The one place both modules get
  // activated together — used by both init() (first load) and
  // switchProfile() (every later switch) so the sequence only lives once.
  activateProfile(id) {
    StorageManager.setProfile(id);
    BookmarkManager.setProfile(id);
  },

  getActiveProfileId() {
    return this.state.activeProfileId;
  },

  getActiveProfile() {
    return this.state.profiles.find(p => p.id === this.state.activeProfileId) || null;
  },

  listProfiles() {
    return this.state.profiles;
  },

  createProfile(name) {
    const trimmed = (name || '').trim();
    const profile = { id: this.generateId(), name: trimmed || '新资料', createdAt: Date.now() };
    this.state.profiles.push(profile);
    this.save();
    return profile;
  },

  renameProfile(id, name) {
    const profile = this.state.profiles.find(p => p.id === id);
    const trimmed = (name || '').trim();
    if (!profile || !trimmed) return;
    profile.name = trimmed;
    this.save();
    if (id === this.state.activeProfileId) this.updateProfileButtonLabel();
  },

  // Refuses to delete the last remaining profile — the app always needs
  // at least one to be in a valid state, and there's no "create a
  // replacement first" flow to fall back on mid-deletion. Callers should
  // check listProfiles().length > 1 before even offering delete for the
  // last one (see the panel-render logic below), so this is a defensive
  // backstop, not the primary guard.
  deleteProfile(id) {
    if (this.state.profiles.length <= 1) return false;
    const wasActive = id === this.state.activeProfileId;
    this.state.profiles = this.state.profiles.filter(p => p.id !== id);
    try {
      localStorage.removeItem(`${HISTORY_KEY_BASE}.${id}`);
      localStorage.removeItem(`${BOOKMARKS_KEY_BASE}.${id}`);
    } catch (e) {
      console.warn("ProfileManager: failed to clean up deleted profile's data.", e);
    }
    if (wasActive) {
      // Clear the in-memory active-session reference *before* calling
      // switchProfile() below. Without this, switchProfile()'s own
      // flush-before-switch step (HistoryManager.saveActiveSession(true),
      // if isStudyMode) would still write through StorageManager's
      // current key — which at that point is still this just-deleted
      // profile's key, since the storage pointer doesn't move to the new
      // profile until later in switchProfile() — silently resurrecting
      // the exact localStorage key removeItem() just cleared above.
      // saveActiveSession() no-ops on a null activeSession, so this
      // makes that flush step safe regardless of study-mode state.
      HistoryManager.state.activeSession = null;
      // switchProfile() saves the profile list itself as part of
      // switching, so no separate save() call is needed on this branch.
      this.switchProfile(this.state.profiles[0].id);
    } else {
      this.save();
    }
    return true;
  },

  // Switches the active profile and fully resets the app to reflect it.
  // Flushes whatever the outgoing profile was doing first — while
  // app.state still genuinely belongs to it, before anything below
  // changes out from under it — then re-points storage and asks HanziApp
  // to reset/re-render as if freshly loaded under the new profile.
  // This needs to happen even outside study mode, because a profile switch
  // should never silently drop the previous profile's pending session data.
  switchProfile(id) {
    if (id === this.state.activeProfileId) return;
    const profile = this.state.profiles.find(p => p.id === id);
    if (!profile) return;

    HistoryManager.saveActiveSession(true);

    this.state.activeProfileId = id;
    this.save();
    this.activateProfile(id);
    HistoryManager.loadHistoryState();
    this.app.resetForProfileSwitch();
    this.closeProfilePanel();
  },

  // --- Profile panel UI ---

  openProfilePanel() {
    this.renderProfilePanelList();
    this.app.dom.profilePanel.classList.add('open');
    document.addEventListener('keydown', this.handleProfilePanelKeydown);
    const firstCard = this.app.dom.profilePanelList.querySelector('.profile-card');
    this.app.openFocusTrap(this.app.dom.profilePanel, firstCard || this.app.dom.profilePanelClose);
  },

  closeProfilePanel() {
    if (!this.app.dom.profilePanel.classList.contains('open')) return;
    this.app.dom.profilePanel.classList.remove('open');
    document.removeEventListener('keydown', this.handleProfilePanelKeydown);
    this.app.closeFocusTrap();
  },

  handleProfilePanelKeydown(e) {
    if (e.key === 'Escape') ProfileManager.closeProfilePanel();
  },

  renderProfilePanelList() {
    const iconEdit = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const iconDelete = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    const canDelete = this.state.profiles.length > 1;

    this.app.dom.profilePanelList.innerHTML = this.state.profiles.map(profile => {
      const isActive = profile.id === this.state.activeProfileId;
      return Templates.profileCard(profile, isActive, canDelete, iconEdit, iconDelete, escapeHtml);
    }).join('');

    this.app.dom.profilePanelList.querySelectorAll('.profile-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.profile-rename-btn') || e.target.closest('.profile-delete-btn')) return;
        this.switchProfile(card.dataset.profileId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.switchProfile(card.dataset.profileId); }
      });
    });
    this.app.dom.profilePanelList.querySelectorAll('.profile-rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.renameProfileFlow(btn.dataset.profileId); });
    });
    this.app.dom.profilePanelList.querySelectorAll('.profile-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteProfileFlow(btn.dataset.profileId); });
    });
  },

  createProfileFlow() {
    this.app.openMiniModal({
      title: '新建资料',
      withInput: true,
      inputValue: '',
      confirmLabel: '创建',
      onConfirm: (value) => {
        const profile = this.createProfile(value);
        this.switchProfile(profile.id);
      }
    });
  },

  renameProfileFlow(id) {
    const profile = this.state.profiles.find(p => p.id === id);
    if (!profile) return;
    this.app.openMiniModal({
      title: '重命名资料',
      withInput: true,
      inputValue: profile.name,
      confirmLabel: '保存',
      onConfirm: (value) => {
        this.renameProfile(id, value);
        this.renderProfilePanelList();
      }
    });
  },

  deleteProfileFlow(id) {
    const profile = this.state.profiles.find(p => p.id === id);
    if (!profile || this.state.profiles.length <= 1) return;
    this.app.openMiniModal({
      title: '删除资料',
      text: `确定要删除"${profile.name}"吗？该资料下的所有练习记录和收藏都将永久删除，无法恢复。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        this.deleteProfile(id);
        this.renderProfilePanelList();
      }
    });
  },

  // Keeps the header's profile button showing the current profile's name
  // — called after init, after switching, and after renaming the active
  // profile.
  updateProfileButtonLabel() {
    const profile = this.getActiveProfile();
    if (this.app.dom.profileBtnName) {
      this.app.dom.profileBtnName.textContent = profile ? profile.name : '';
    }
  }
};

export { ProfileManager };
