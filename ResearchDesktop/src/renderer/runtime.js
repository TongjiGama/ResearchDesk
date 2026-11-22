/* Renderer runtime: shared state, bridge services, and controller wiring. */
(() => {
  const namespace = window.ResearchWorkbench || (window.ResearchWorkbench = {});

  class AppState {
    constructor() {
      Object.assign(this, {
        wsList: [],
        ws: '',
        board: 'papers',
        items: [],
        selectedId: null,
        search: '',
        statusFilter: '',
        ideaStageFilter: '',
        cfg: null,
        skills: [],
        dirty: false,
        searchResults: [],
        selection: new Set(),
        ratingCache: {},
        recentSearches: [],
        discoveryQuery: '',
        discoverySort: 'frontier',
        discoveryCount: 0,
        discoveryStrategy: true,
        discoverySkills: [],
        discoverySkillId: 'paper-search-pro',
        discoverySources: ['openalex', 'arxiv', 'openreview', 'huggingface', 'crossref'],
        discoveryFilters: {
          yearFrom: '',
          yearTo: '',
          minCitations: '',
          peerReviewedOnly: false,
          hasCodeOnly: false,
          hasPdfOnly: false,
          hideDuplicates: false
        },
        discoveryResultSourceFilter: '',
        discoveryResultGradeFilter: '',
        discoveryUseWorkspaceSeeds: true,
        discoveryAiScreening: false,
        discoveryFiltersOpen: false,
        discoveryMeta: null,
        discoveryExpandedAbstracts: new Set(),
        discoveryRequestId: 0,
        timelineRequestId: 0,
        lastSelected: {},
        modalTrigger: null
      });
    }
  }

  class RendererServices {
    constructor(bridge) {
      this.bridge = bridge;
    }

    async store(method, ...args) {
      const result = await this.bridge.store.call(method, ...args);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    }

    async ai(method, ...args) {
      const result = await this.bridge.ai.call(method, ...args);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    }

    async service(service, method, ...args) {
      const result = await this.bridge.service.call(service, method, ...args);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    }
  }

  class ControllerRegistry {
    constructor() {
      this.controllers = new Map();
      this.owners = new Map();
    }

    register(name, controller) {
      Object.keys(controller).forEach((method) => {
        if (typeof controller[method] !== 'function') return;
        if (this.owners.has(method)) throw new Error(`重复的渲染器控制器方法：${method}`);
        this.owners.set(method, name);
      });
      this.controllers.set(name, controller);
    }

    invoke(method, args) {
      const owner = this.owners.get(method);
      const controller = owner && this.controllers.get(owner);
      if (!controller || typeof controller[method] !== 'function') {
        throw new Error(`未注册的渲染器控制器方法：${method}`);
      }
      return controller[method](...args);
    }

    createActions(coreActions) {
      return new Proxy(Object.create(null), {
        get: (_, property) => {
          if (typeof property !== 'string') return undefined;
          if (Object.prototype.hasOwnProperty.call(coreActions, property)) return coreActions[property];
          return (...args) => this.invoke(property, args);
        }
      });
    }
  }

  class AppContext {
    constructor({ state, dom, services, constants, ui, registry, coreActions }) {
      this.state = state;
      this.dom = dom;
      this.services = services;
      this.constants = constants;
      this.ui = ui;
      this.actions = registry.createActions(coreActions);
      this.hasAction = (method) => registry.owners.has(method) || Object.prototype.hasOwnProperty.call(coreActions || {}, method);
    }
  }

  Object.assign(namespace, { AppState, RendererServices, ControllerRegistry, AppContext });
})();
