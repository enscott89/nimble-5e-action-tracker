const moduleId = "nimble-5e-action-tracker";
const legacyModuleId = "3-action-tracker";
const socketEvent = `module.${moduleId}`;

function localize(key) {
  return game.i18n.localize(key);
}

function getModuleStore() {
  const module = game.modules.get(moduleId);
  if (!module.trackers) module.trackers = [];
  return module.trackers;
}

function createTrackerState(source = {}) {
  const numOfActions = Number(source.numOfActions ?? game.settings.get(moduleId, "defaultActions") ?? 3);
  const isDying = Boolean(source.isDying);
  const actionCount = isDying ? 1 : numOfActions;
  const spentActions = Number(source.spentActions ?? countClassEntries(source.classNameListActions, "symbolClick"));
  const wounds = Number(source.wounds ?? countClassEntries(source.classNameListWounds, "woundActive"));
  const hasReaction = Boolean(source.hasReaction);
  const reactionSpent = Boolean(source.reactionSpent);

  return {
    trackerId: source.trackerId ?? foundry.utils.randomID(),
    title: source.title ?? game.settings.get(moduleId, "trackerName"),
    numOfActions,
    isDying,
    spentActions: clamp(spentActions, 0, actionCount),
    hasReaction,
    reactionSpent,
    wounds: clamp(wounds, 0, 6),
    actionColor: source.actionColor ?? game.settings.get(moduleId, "actionColor"),
    reactionColor: source.reactionColor ?? game.settings.get(moduleId, "reactionColor"),
    actorUuid: source.actorUuid,
    sentFromUserId: source.sentFromUserId ?? game.userId,
    userListPermissions: normalizeUserIds(source.userListPermissions ?? [game.userId]),
    duplicationNr: source.duplicationNr ?? 0
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function countClassEntries(list, className) {
  if (!Array.isArray(list)) return 0;
  return list.filter((entry) => String(entry).includes(className)).length;
}

function createActorTrackerState(actor) {
  const savedState = actor.getFlag(moduleId, "trackerState") ?? actor.getFlag(legacyModuleId, "trackerState") ?? {};
  return createTrackerState({
    ...savedState,
    trackerId: actor.uuid,
    title: savedState.title ?? actor.name,
    actorUuid: actor.uuid
  });
}

function createHomeTrackerState() {
  const savedState = getSavedClientTrackerState("home");
  return createTrackerState({
    ...savedState,
    trackerId: "home"
  });
}

function getSavedClientTrackerState(trackerId) {
  const savedTrackers = game.settings.get(moduleId, "savedTrackers") ?? {};
  return savedTrackers[trackerId] ?? {};
}

function toPersistedState(state) {
  return {
    trackerId: state.trackerId,
    title: state.title,
    numOfActions: state.numOfActions,
    isDying: state.isDying,
    spentActions: state.spentActions,
    hasReaction: state.hasReaction,
    reactionSpent: state.reactionSpent,
    wounds: state.wounds,
    actionColor: state.actionColor,
    reactionColor: state.reactionColor,
    actorUuid: state.actorUuid
  };
}

function getSelectedActor() {
  const token = canvas?.tokens?.controlled?.[0];
  return token?.actor ?? null;
}

function getActorName(actorUuid) {
  if (!actorUuid || typeof fromUuidSync !== "function") return localize("ThreeActionTracker.NoLinkedActor");
  const actor = fromUuidSync(actorUuid);
  return actor?.name ?? localize("ThreeActionTracker.NoLinkedActor");
}

function normalizeUserIds(users) {
  return Array.from(new Set((Array.isArray(users) ? users : [users]).map((user) => {
    const value = String(user);
    if (game.users.get(value)) return value;
    return game.users.find((candidate) => candidate.name === value)?.id ?? value;
  })));
}

function hasTrackerPermission(state) {
  return normalizeUserIds(state.userListPermissions).includes(game.userId);
}

class SelectiveShowApp extends FormApplication {
  constructor(users, state) {
    super(users);
    this.userNameList = users;
    this.trackerState = state;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "three-action-tracker-selective-show",
      template: `modules/${moduleId}/templates/selectiveshow.html`,
      classes: ["selective-show"],
      height: 265,
      width: 220,
      minimizable: true,
      resizable: true,
      title: localize("selectiveshow.SelectiveShow")
    });
  }

  async getData() {
    const data = await super.getData();
    data.users = game.users.filter((u) => u.active && u.id !== game.user.id);
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find(".show").click((ev) => {
      ev.preventDefault();
      this._updateObject();
      game.socket?.emit(socketEvent, {
        operation: "showToSelection",
        state: this.trackerState,
        userList: this.userNameList
      });
      this.close();
    });

    html.find(".show-all").click((ev) => {
      ev.preventDefault();
      this._updateObject();
      game.socket?.emit(socketEvent, {
        operation: "showToAll",
        state: this.trackerState
      });
      this.close();
    });

    html.find(".show-permissions").click((ev) => {
      ev.preventDefault();
      this._updateObject();
      this.trackerState.userListPermissions = this.userNameList;
      game.socket?.emit(socketEvent, {
        operation: "showWithPermission",
        state: this.trackerState,
        userList: this.userNameList
      });
      this.close();
    });

    html.find(".send-to-chat").click((ev) => {
      ev.preventDefault();
      this._updateObject();
      handleSendToChat({ state: this.trackerState });
      this.close();
    });
  }

  _updateObject() {
    const selector = this.element.find("select[name='users']")[0];
    this.userNameList = Array.from(selector?.selectedOptions ?? []).map((option) => option.value);
    if (!this.userNameList.includes(game.userId)) this.userNameList.push(game.userId);
    return Promise.resolve();
  }

  _handleShowPlayers(state) {
    this.trackerState = state;
    switch (game.settings.get(moduleId, "showPlayer")) {
      case "Normal":
        this.render(true, { focus: false });
        break;
      case "Chat":
        handleSendToChat({ state });
        break;
    }
  }
}

class ThreeActionTracker extends Application {
  constructor(newState) {
    super();
    this.clickString = "symbolClick";
    this.state = createTrackerState(newState);
    this.showPlayerHandler = new SelectiveShowApp([game.userId], this.state);
  }

  get title() {
    let title = this.state.title || localize("ThreeActionTracker.WindowTitle");
    if (this.state.sentFromUserId !== game.userId) {
      const user = game.users.get(this.state.sentFromUserId);
      title = `${title} ${localize("ThreeActionTracker.SentFrom")} ${user ? user.name : localize("ThreeActionTracker.UnknownUser")}`;
    }
    if (this.state.duplicationNr > 0) title = `${title} (${this.state.duplicationNr})`;
    return title;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "ThreeActionTracker",
      template: `modules/${moduleId}/templates/result.hbs`,
      width: 260,
      height: 112,
      resizable: true,
      classes: ["three-action-tracker"],
      title: "ThreeActionTracker.WindowTitle"
    });
  }

  getData() {
    this.updateState();
    return {
      title: this.state.title,
      numOfActions: this.state.numOfActions,
      isDying: this.state.isDying,
      actionStyle: `--tracker-color: ${this.state.actionColor};`,
      reactionStyle: `--tracker-color: ${this.state.reactionColor};`,
      actionPayload: this.buildHandlebarPayload(this.getActionCount()),
      hasReaction: this.state.hasReaction && !this.state.isDying,
      reactionClass: this.state.reactionSpent ? "tracker-symbol reaction-symbol symbolClick" : "tracker-symbol reaction-symbol",
      woundPayload: this.buildWoundPayload(),
      dyingButtonLabel: localize(this.state.isDying ? "ThreeActionTracker.DisableDyingMode" : "ThreeActionTracker.EnableDyingMode")
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    if (!hasTrackerPermission(this.state)) return;

    html.find(".tracker-symbol").on("click", this._onClickSymbol.bind(this));
    html.find(".reaction-symbol").on("click", this._onClickReaction.bind(this));
    html.find(".wound-tick").on("click", this._onClickWound.bind(this));
    html.find(".reset-actions").on("click", this._onResetActions.bind(this));
    html.find(".dying-toggle").on("click", this._onToggleDying.bind(this));
    html.find(".wound-recover").on("click", this._onRecoverWound.bind(this));
  }

  async close(options) {
    await super.close(options);
    const trackers = getModuleStore();
    const index = trackers.indexOf(this);
    if (index > -1) trackers.splice(index, 1);
  }

  _getHeaderButtons() {
    const buttons = super._getHeaderButtons();

    buttons.unshift({
      label: localize("ThreeActionTracker.Customize"),
      class: "customize-tracker",
      icon: "fas fa-palette",
      onclick: () => this._onHeaderCustomize()
    });

    if (game.settings.get(moduleId, "showPlayer") !== "Hide") {
      buttons.unshift({
        label: localize("ThreeActionTracker.Show"),
        class: "share-tracker",
        icon: "fas fa-eye",
        onclick: () => this.showPlayerHandler._handleShowPlayers(this.getState())
      });
    }

    if (game.settings.get(moduleId, "duplicateButton")) {
      buttons.unshift({
        label: localize("ThreeActionTracker.Duplication"),
        class: "duplicate-tracker",
        icon: "fas fa-clone",
        onclick: () => handleDuplication({ state: this.getState() })
      });
    }

    return buttons;
  }

  _onClickSymbol(event) {
    event.preventDefault();
    if (event.currentTarget.classList.contains("reaction-symbol")) return;
    const actionCount = this.getActionCount();
    this.state.spentActions = this.state.spentActions >= actionCount ? 0 : this.state.spentActions + 1;
    this.render(false, { focus: false });
    this.emitUpdate();
  }

  _onClickReaction(event) {
    event.preventDefault();
    this.state.reactionSpent = !this.state.reactionSpent;
    this.render(false, { focus: false });
    this.emitUpdate();
  }

  _onClickWound(event) {
    event.preventDefault();
    this.state.wounds = this.state.wounds >= 6 ? 0 : this.state.wounds + 1;
    this.render(false, { focus: false });
    this.emitUpdate();
  }

  _onRecoverWound(event) {
    event.preventDefault();
    this.state.wounds = clamp(this.state.wounds - 1, 0, 6);
    this.render(false, { focus: false });
    this.emitUpdate();
  }

  _onResetActions(event) {
    event.preventDefault();
    this.state.spentActions = 0;
    this.state.reactionSpent = false;
    this.render(false, { focus: false });
    this.emitUpdate();
  }

  _onToggleDying(event) {
    event.preventDefault();
    this.state.isDying = !this.state.isDying;
    this.state.spentActions = clamp(this.state.spentActions, 0, this.getActionCount());
    if (this.state.isDying) {
      this.state.reactionSpent = false;
      this.state.wounds = clamp(this.state.wounds + 1, 0, 6);
    }
    this.render(false, { focus: false });
    this.emitUpdate();
  }

  _linkSelectedActor() {
    const actor = getSelectedActor();
    if (!actor) {
      ui.notifications?.warn(localize("ThreeActionTracker.NoActorSelected"));
      return false;
    }

    this.state.trackerId = actor.uuid;
    this.state.actorUuid = actor.uuid;
    this.state.title = actor.name;
    this.saveState();
    return true;
  }

  async _onHeaderCustomize() {
    const content = await renderTemplate(`modules/${moduleId}/templates/customize.hbs`, this.getCustomizeData());
    new Dialog({
      title: localize("ThreeActionTracker.Customize"),
      content,
      classes: ["dialog", "three-action-customize-dialog"],
      buttons: {
        save: {
          icon: '<i class="fas fa-save"></i>',
          label: localize("ThreeActionTracker.Save"),
          callback: (html) => {
            const form = html.find("form")[0];
            const data = new FormDataExtended(form).object;
            const value = Math.max(0, Number(data.numOfActions));
            if (Number.isFinite(value)) this.state.numOfActions = value;
            this.state.title = String(data.title || localize("ThreeActionTracker.WindowTitle"));
            this.state.actionColor = String(data.actionColor || "#5bbcff");
            this.state.hasReaction = Boolean(data.hasReaction);
            this.state.reactionColor = String(data.reactionColor || "#d49b39");
            if (!this.state.hasReaction) this.state.reactionSpent = false;
            if (data.linkSelectedActor) this._linkSelectedActor();
            this.render(false, { focus: false });
            this.emitUpdate();
          }
        },
        cancel: {
          label: localize("ThreeActionTracker.Cancel")
        }
      },
      default: "save"
    }).render(true);
  }

  getCustomizeData() {
    return {
      title: this.state.title,
      numOfActions: this.state.numOfActions,
      actionColor: this.state.actionColor,
      hasReaction: this.state.hasReaction,
      reactionColor: this.state.reactionColor,
      actorName: getActorName(this.state.actorUuid)
    };
  }

  getActionCount() {
    return this.state.isDying ? 1 : this.state.numOfActions;
  }

  buildHandlebarPayload(iterator) {
    const payload = [];
    for (let index = 0; index < iterator; index++) {
      const spentFromRight = index >= iterator - this.state.spentActions;
      payload.push({ number: index, cssClass: spentFromRight ? "tracker-symbol symbolClick" : "tracker-symbol" });
    }
    return payload;
  }

  buildWoundPayload() {
    const payload = [];
    for (let index = 0; index < 6; index++) {
      const woundedFromRight = index >= 6 - this.state.wounds;
      const terminalWounds = this.state.wounds >= 6;
      payload.push({
        number: index,
        cssClass: woundedFromRight ? `wound-tick woundActive${terminalWounds ? " woundTerminal" : ""}` : "wound-tick"
      });
    }
    return payload;
  }

  updateState() {
    this.state.spentActions = clamp(this.state.spentActions, 0, this.getActionCount());
    this.state.reactionSpent = Boolean(this.state.reactionSpent);
    this.state.wounds = clamp(this.state.wounds, 0, 6);
  }

  emitUpdate() {
    this.saveState();
    game.socket?.emit(socketEvent, {
      operation: "update",
      state: this.getState()
    });
  }

  async saveState() {
    const persistedState = toPersistedState(this.state);
    if (this.state.actorUuid && typeof fromUuidSync === "function") {
      const actor = fromUuidSync(this.state.actorUuid);
      if (actor?.setFlag) {
        await actor.setFlag(moduleId, "trackerState", persistedState);
        return;
      }
    }

    const savedTrackers = foundry.utils.deepClone(game.settings.get(moduleId, "savedTrackers") ?? {});
    savedTrackers[this.state.trackerId || "home"] = persistedState;
    await game.settings.set(moduleId, "savedTrackers", savedTrackers);
  }

  setState(newState) {
    this.state = createTrackerState(foundry.utils.deepClone(newState));
    this.showPlayerHandler.trackerState = this.state;
  }

  getState() {
    return foundry.utils.deepClone(this.state);
  }
}

function handleShowToAll(data) {
  const dialog = checkAndBuildApp(data);
  dialog.render(true, { id: `ThreeActionTracker-${data.state.trackerId}`, focus: false });
}

function handleShowToSelection(data) {
  if (data.userList?.includes(String(game.userId))) handleShowToAll(data);
}

function handleShowWithPermission(data) {
  handleShowToSelection(data);
}

function handleUpdate(data) {
  const app = checkForApp(data, true);
  if (!app) return;

  app.setState(data.state);
  app.render(false, { focus: false });
}

function handleDuplication(data) {
  const newState = createTrackerState(foundry.utils.deepClone(data.state));
  newState.trackerId = foundry.utils.randomID();
  newState.actorUuid = undefined;
  newState.sentFromUserId = game.userId;

  do {
    newState.duplicationNr += 1;
  } while (checkForApp({ state: newState }, true));

  const dialog = new ThreeActionTracker(newState);
  getModuleStore().push(dialog);
  dialog.render(true, { id: `ThreeActionTracker-${newState.trackerId}`, focus: false });
}

function handleSendToChat(data) {
  const app = checkForApp(data, true);
  if (!app?.rendered) return;

  const content = app.element.find(".window-content").find(".tracker-main").clone();
  content.find("input").each((_, input) => {
    const value = input.value;
    input.replaceWith(`<span class="chat-counter">${value}</span>`);
  });
  ChatMessage.create({ content: content.prop("outerHTML") });
}

function checkForApp(data, ignoreUser = false) {
  return getModuleStore().find((app) => {
    const appState = app.getState();
    const userMatches = ignoreUser || appState.sentFromUserId === data.state.sentFromUserId;
    const actorMatches = appState.actorUuid && appState.actorUuid === data.state.actorUuid;
    return userMatches && (actorMatches || appState.trackerId === data.state.trackerId);
  });
}

function checkAndBuildApp(data) {
  const app = checkForApp(data, true);
  if (app) return app;

  const newApp = new ThreeActionTracker(data.state);
  getModuleStore().push(newApp);
  return newApp;
}

function settingSetup() {
  game.settings.register(moduleId, "trackerName", {
    name: "ThreeActionTracker.Settings.TrackerName",
    hint: "ThreeActionTracker.Settings.TrackerNameHint",
    config: true,
    scope: "client",
    type: String,
    default: "Nimble Actions"
  });

  game.settings.register(moduleId, "defaultActions", {
    name: "ThreeActionTracker.Settings.DefaultActions",
    hint: "ThreeActionTracker.Settings.DefaultActionsHint",
    config: true,
    scope: "client",
    type: Number,
    default: 3,
    range: { min: 0, max: 10, step: 1 }
  });

  game.settings.register(moduleId, "actionColor", {
    name: "ThreeActionTracker.Settings.ActionColor",
    hint: "ThreeActionTracker.Settings.ActionColorHint",
    config: true,
    scope: "client",
    type: String,
    default: "#5bbcff"
  });

  game.settings.register(moduleId, "reactionColor", {
    name: "ThreeActionTracker.Settings.ReactionColor",
    hint: "ThreeActionTracker.Settings.ReactionColorHint",
    config: true,
    scope: "client",
    type: String,
    default: "#d49b39"
  });

  game.settings.register(moduleId, "duplicateButton", {
    name: "ThreeActionTracker.Settings.DuplicateSetting",
    hint: "ThreeActionTracker.Settings.DuplicateHint",
    config: true,
    scope: "client",
    type: Boolean,
    default: true
  });

  game.settings.register(moduleId, "showPlayer", {
    name: "ThreeActionTracker.Settings.ShowPlayerSetting",
    hint: "ThreeActionTracker.Settings.ShowPlayerHint",
    config: true,
    scope: "client",
    type: String,
    choices: {
      Hide: "ThreeActionTracker.Settings.ShowPlayerChoices.Hide",
      Normal: "ThreeActionTracker.Settings.ShowPlayerChoices.Normal",
      Chat: "ThreeActionTracker.Settings.ShowPlayerChoices.Chat"
    },
    default: "Normal"
  });

  game.settings.register(moduleId, "savedTrackers", {
    name: "ThreeActionTracker.Settings.SavedTrackers",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
}

function addSceneControlButton(controls) {
  const tool = {
    name: "three-action-tracker",
    title: "ThreeActionTracker.ButtonHint",
    icon: "fas fa-list-check",
    button: true,
    visible: true,
    onClick: () => openTrackerForSelection()
  };

  if (Array.isArray(controls)) {
    const tokenControls = controls.find((control) => control.name === "token");
    tokenControls?.tools?.push(tool);
    return;
  }

  const tokenControls = controls.tokens ?? controls.token;
  if (tokenControls?.tools instanceof Map) tokenControls.tools.set(tool.name, tool);
  else if (Array.isArray(tokenControls?.tools)) tokenControls.tools.push(tool);
  else if (tokenControls?.tools && typeof tokenControls.tools === "object") tokenControls.tools[tool.name] = tool;
}

function openTrackerForSelection() {
  const actor = getSelectedActor();
  if (!actor) {
    homeTracker.render(true, { focus: false });
    return;
  }

  const data = { state: createActorTrackerState(actor) };
  const app = checkAndBuildApp(data);
  app.render(true, { id: `ThreeActionTracker-${actor.id}`, focus: false });
}

let homeTracker;

Hooks.once("init", () => {
  console.log(`Initializing ${moduleId}`);
  settingSetup();
});

Hooks.on("getSceneControlButtons", addSceneControlButton);

Hooks.on("ready", () => {
  homeTracker = new ThreeActionTracker(createHomeTrackerState());
  getModuleStore().push(homeTracker);

  game.socket?.on(socketEvent, (data) => {
    switch (data.operation) {
      case "showToAll":
        handleShowToAll(data);
        break;
      case "showToSelection":
        handleShowToSelection(data);
        break;
      case "showWithPermission":
        handleShowWithPermission(data);
        break;
      case "update":
        handleUpdate(data);
        break;
      default:
        console.log(data);
        break;
    }
  });
});
