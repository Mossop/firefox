/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  EveryWindow: "resource:///modules/EveryWindow.sys.mjs",
});

const DEBOUNCE_MS = 30000;

export const EphemeralContainerWatcher = {
  _ephemeralIds: new Set(),
  _deferredTasks: new Map(),
  _initialized: false,

  init(ephemeralUserContextIds) {
    this._ephemeralIds = ephemeralUserContextIds;
    this._cancelStaleTimers();

    if (this._initialized) {
      return;
    }
    this._initialized = true;

    lazy.EveryWindow.registerCallback(
      "EphemeralContainerWatcher",
      win => this._onWindowInit(win),
      (win, closing) => this._onWindowUninit(win, closing)
    );
  },

  destroy() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;

    this._ephemeralIds.clear();
    this._cancelStaleTimers();
    lazy.EveryWindow.unregisterCallback("EphemeralContainerWatcher");
  },

  _cancelStaleTimers() {
    for (let [userContextId, task] of this._deferredTasks) {
      if (!this._ephemeralIds.has(userContextId)) {
        task.disarm();
        this._deferredTasks.delete(userContextId);
      }
    }
  },

  _onWindowInit(win) {
    win.gBrowser.tabContainer.addEventListener("TabClose", this);
  },

  _onWindowUninit(win, closing) {
    win.gBrowser.tabContainer.removeEventListener("TabClose", this);
    if (closing) {
      for (let userContextId of this._ephemeralIds) {
        this._scheduleCheck(userContextId);
      }
    }
  },

  handleEvent(event) {
    let tab = event.target;
    let userContextId = tab.getAttribute("usercontextid");
    if (!userContextId) {
      return;
    }
    userContextId = parseInt(userContextId, 10);
    if (this._ephemeralIds.has(userContextId)) {
      this._scheduleCheck(userContextId);
    }
  },

  _scheduleCheck(userContextId) {
    let task = this._deferredTasks.getOrInsertComputed(userContextId, () => {
      return new lazy.DeferredTask(() => {
        if (
          lazy.ContextualIdentityService.countContainerTabs(userContextId) == 0
        ) {
          return this._clearData(userContextId);
        }
        return undefined;
      }, DEBOUNCE_MS);
    });
    task.disarm();
    task.arm();
  },

  _clearData(userContextId) {
    return new Promise(resolve => {
      Services.clearData.deleteDataFromOriginAttributesPattern(
        { userContextId },
        resolve
      );
    });
  },

  clearAll() {
    let promises = [];
    for (let userContextId of this._ephemeralIds) {
      promises.push(this._clearData(userContextId));
    }
    return Promise.all(promises);
  },

  async flushPendingChecks() {
    let tasks = [...this._deferredTasks.values()];
    this._deferredTasks.clear();
    await Promise.all(tasks.map(t => t.finalize()));
  },
};
