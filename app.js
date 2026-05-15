import * as THREE from "https://unpkg.com/three@0.164.1/build/three.module.js";

const STORAGE_KEY = "book-orbit-state-v1";

const dom = {
  sceneHost: document.querySelector("#scene-host"),
  searchForm: document.querySelector("#search-form"),
  query: document.querySelector("#book-query"),
  clearSearch: document.querySelector("#clear-search"),
  resultsPanel: document.querySelector("#results-panel"),
  resultsStatus: document.querySelector("#results-status"),
  resultsList: document.querySelector("#results-list"),
  lineupToggle: document.querySelector("#lineup-toggle"),
  orbitToggle: document.querySelector("#orbit-toggle"),
  doneToggle: document.querySelector("#done-toggle"),
  orbitCount: document.querySelector("#orbit-count"),
  doneCount: document.querySelector("#done-count"),
  orbitPanel: document.querySelector("#orbit-panel"),
  donePanel: document.querySelector("#done-panel"),
  orbitPanelCount: document.querySelector("#orbit-panel-count"),
  donePanelCount: document.querySelector("#done-panel-count"),
  orbitList: document.querySelector("#orbit-list"),
  doneList: document.querySelector("#done-list"),
  modal: document.querySelector("#complete-modal"),
  modalCover: document.querySelector("#modal-cover"),
  modalTitle: document.querySelector("#modal-title"),
  modalAuthor: document.querySelector("#modal-author"),
  modalCancel: document.querySelector("#modal-cancel"),
  modalConfirm: document.querySelector("#modal-confirm"),
};

const state = {
  abortController: null,
  activeModalBook: null,
  completed: new Set(),
  completedBooks: new Map(),
  completedCount: 0,
  dragging: null,
  layoutMode: "orbit",
  orbitBooks: new Map(),
  query: "",
  results: [],
  resultsSuppressed: false,
  saveTimer: 0,
  searchTimer: 0,
  sidePanels: {
    done: false,
    orbit: false,
  },
  suppressSceneClick: false,
};

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x00030a, 0.055);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 0, 7.1);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
dom.sceneHost.appendChild(renderer.domElement);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pointerDown = new THREE.Vector2();
const clock = new THREE.Clock();
const center = new THREE.Vector3(0, 0, 0);
const clickTargets = [];
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("anonymous");

let viewport = getViewport();
let blackHoleActiveUntil = 0;

const ambient = new THREE.AmbientLight(0xdff8ff, 1.15);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0x9eefff, 1.35);
keyLight.position.set(3.5, 3.2, 4.5);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xffb86a, 0.72);
rimLight.position.set(-4.5, -2.2, 2.6);
scene.add(rimLight);

const starField = createStarField();
scene.add(starField);

const blackHole = createBlackHole();
scene.add(blackHole.group);

dom.searchForm.addEventListener("submit", (event) => event.preventDefault());
dom.query.addEventListener("input", handleQueryInput);
dom.query.addEventListener("focus", () => {
  if (state.query && state.results.length) {
    state.resultsSuppressed = false;
    renderResults();
  }
});
dom.clearSearch.addEventListener("click", clearSearch);
dom.resultsList.addEventListener("click", handleResultClick);
dom.orbitList.addEventListener("click", (event) => handleSideListClick(event, "orbit"));
dom.doneList.addEventListener("click", (event) => handleSideListClick(event, "done"));
dom.lineupToggle.addEventListener("click", toggleLineupMode);
dom.orbitToggle.addEventListener("click", () => toggleSidePanel("orbit"));
dom.doneToggle.addEventListener("click", () => toggleSidePanel("done"));
dom.modalCancel.addEventListener("click", closeModal);
dom.modalConfirm.addEventListener("click", confirmCompleted);
dom.modal.addEventListener("click", (event) => {
  if (event.target.hasAttribute("data-modal-close")) {
    closeModal();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dom.modal.hidden) {
    closeModal();
  }
});
window.addEventListener("resize", resizeScene);
renderer.domElement.addEventListener("pointerdown", handleScenePointerDown);
renderer.domElement.addEventListener("pointermove", handleScenePointerMove);
renderer.domElement.addEventListener("pointerup", handleScenePointerUp);
renderer.domElement.addEventListener("pointercancel", handleScenePointerCancel);
renderer.domElement.addEventListener("click", handleSceneClick);

resizeScene();
animate();
queueMicrotask(loadPersistedState);

function handleQueryInput() {
  const query = dom.query.value.trim();
  state.query = query;
  state.resultsSuppressed = false;
  dom.clearSearch.classList.toggle("is-visible", query.length > 0);

  window.clearTimeout(state.searchTimer);
  if (!query) {
    state.results = [];
    renderResults();
    return;
  }

  dom.resultsPanel.hidden = false;
  dom.resultsStatus.textContent = "검색 중";
  dom.resultsList.replaceChildren();

  state.searchTimer = window.setTimeout(() => searchBooks(query), 280);
}

function clearSearch() {
  dom.query.value = "";
  dom.query.focus();
  state.query = "";
  state.results = [];
  state.resultsSuppressed = false;
  dom.clearSearch.classList.remove("is-visible");
  if (state.abortController) {
    state.abortController.abort();
  }
  renderResults();
}

async function searchBooks(query) {
  if (state.abortController) {
    state.abortController.abort();
  }

  const controller = new AbortController();
  state.abortController = controller;
  const url = `/api/search?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }

    const payload = await response.json();
    state.results = normalizeBooks(payload.books || []);
    renderResults();
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    dom.resultsPanel.hidden = false;
    dom.resultsStatus.textContent = "검색을 불러오지 못했습니다";
    dom.resultsList.replaceChildren();
  }
}

function normalizeBooks(items) {
  const seen = new Set();
  const books = [];

  for (const item of items) {
    const title = (item.title || "").trim();
    const coverUrl = (item.coverUrl || "").trim();
    if (!title || !coverUrl) {
      continue;
    }

    const authors = Array.isArray(item.authors) ? item.authors.filter(Boolean).slice(0, 3) : [];
    const publisher = item.publisher || "국내 정발";
    const dedupeKey = normalizeText(`${title} ${authors[0] || ""} ${publisher}`);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    books.push({
      id: item.id || dedupeKey,
      title,
      authors,
      publisher,
      year: item.year || "",
      status: item.status || "",
      source: item.source || "국내 정발",
      isMinumsa: Boolean(item.isMinumsa),
      coverUrl,
      largeCoverUrl: item.largeCoverUrl || coverUrl,
      detailUrl: item.detailUrl || "",
    });
  }

  return books.slice(0, 12);
}

function renderResults() {
  dom.resultsList.replaceChildren();
  const query = state.query.trim();

  if (!query) {
    dom.resultsPanel.hidden = true;
    dom.resultsStatus.textContent = "";
    return;
  }

  dom.resultsPanel.hidden = false;
  if (state.resultsSuppressed) {
    dom.resultsPanel.hidden = true;
    return;
  }

  if (!state.results.length) {
    dom.resultsStatus.textContent = "표지가 있는 국내 정발 도서 결과가 없습니다";
    return;
  }

  dom.resultsStatus.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const book of state.results) {
    const item = document.createElement("button");
    item.className = "book-result";
    item.type = "button";
    item.dataset.bookId = book.id;
    item.classList.toggle("is-selected", state.orbitBooks.has(book.id));
    item.classList.toggle("is-completed", state.completed.has(book.id));
    item.classList.toggle("is-minumsa", book.isMinumsa);

    const cover = createResultCover(book);
    const copy = document.createElement("div");
    const title = document.createElement("div");
    const meta = document.createElement("div");
    const check = document.createElement("span");

    title.className = "book-result__title";
    title.textContent = book.title;

    meta.className = "book-result__meta";
    meta.append(
      createMetaPiece(book.authors.length ? book.authors.join(", ") : "작가 미상"),
      createMetaPiece(book.publisher || "국내 정발"),
      ...(book.status ? [createMetaPiece(book.status)] : [])
    );

    check.className = "book-result__check";
    check.setAttribute("aria-hidden", "true");

    copy.append(title, meta);
    item.append(cover, copy, check);
    fragment.append(item);
  }

  dom.resultsList.append(fragment);
}

function toggleSidePanel(type) {
  setSidePanel(type, !state.sidePanels[type]);
}

function toggleLineupMode() {
  setLayoutMode(state.layoutMode === "lineup" ? "orbit" : "lineup");
}

function setLayoutMode(mode) {
  state.layoutMode = mode;
  const isLineup = mode === "lineup";
  dom.lineupToggle.setAttribute("aria-pressed", String(isLineup));
  dom.lineupToggle.classList.toggle("is-active", isLineup);
  rebalanceOrbitAnchors();
}

function rebalanceOrbitAnchors({ snap = false } = {}) {
  const books = [...state.orbitBooks.values()];
  books.forEach((entity, index) => {
    if (state.layoutMode === "lineup") {
      entity.setLineupAnchor(index, books.length, { snap });
    } else {
      entity.setOrbitAnchor(index, books.length, { snap });
    }
  });
}

function setSidePanel(type, isOpen) {
  state.sidePanels[type] = isOpen;
  const panel = type === "orbit" ? dom.orbitPanel : dom.donePanel;
  const toggle = type === "orbit" ? dom.orbitToggle : dom.doneToggle;

  renderSideLists();
  panel.classList.toggle("is-open", isOpen);
  panel.setAttribute("aria-hidden", String(!isOpen));
  toggle.setAttribute("aria-expanded", String(isOpen));
}

function renderSideLists() {
  const orbitBooks = [...state.orbitBooks.values()].map((entity) => entity.book);
  const doneBooks = [...state.completedBooks.values()];

  dom.orbitPanelCount.textContent = String(orbitBooks.length);
  dom.donePanelCount.textContent = String(doneBooks.length);
  renderSideList(dom.orbitList, orbitBooks, "orbit");
  renderSideList(dom.doneList, doneBooks, "done");
}

function renderSideList(list, books, type) {
  list.replaceChildren();

  if (!books.length) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = type === "orbit" ? "떠다니는 책이 없습니다" : "완독한 책이 없습니다";
    list.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const book of books) {
    fragment.append(createSideBookItem(book, type));
  }
  list.append(fragment);
}

function createSideBookItem(book, type) {
  const item = document.createElement("article");
  const image = document.createElement("img");
  const copy = document.createElement("div");
  const title = document.createElement("div");
  const meta = document.createElement("div");
  const deleteButton = document.createElement("button");

  item.className = "side-book";
  item.dataset.bookId = book.id;
  item.dataset.listType = type;
  image.src = book.coverUrl || createCoverDataUrl(book);
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener(
    "error",
    () => {
      image.src = createCoverDataUrl(book);
    },
    { once: true }
  );

  copy.className = "side-book__copy";
  title.className = "side-book__title";
  title.textContent = book.title;
  meta.className = "side-book__meta";
  meta.textContent = [book.authors?.join(", "), book.publisher, book.status].filter(Boolean).join(" · ");

  deleteButton.className = "side-book__delete";
  deleteButton.type = "button";
  deleteButton.textContent = "삭제";
  deleteButton.setAttribute("aria-label", `${book.title} 삭제`);

  copy.append(title, meta);
  item.append(image, copy, deleteButton);
  return item;
}

function handleSideListClick(event, type) {
  const button = event.target.closest(".side-book__delete");
  if (!button) {
    return;
  }

  const item = button.closest(".side-book");
  if (!item) {
    return;
  }

  if (type === "orbit") {
    removeOrbitBook(item.dataset.bookId);
  } else {
    removeDoneBook(item.dataset.bookId);
  }
}

function removeOrbitBook(bookId, { shouldSave = true } = {}) {
  const entity = state.orbitBooks.get(bookId);
  if (!entity) {
    return;
  }

  entity.destroy();
  state.orbitBooks.delete(bookId);
  if (state.dragging?.entity === entity) {
    endSceneDrag();
  }
  rebalanceOrbitAnchors();
  renderResults();
  updateCounters();
  if (shouldSave) {
    scheduleStateSave();
  }
}

function removeDoneBook(bookId, { shouldSave = true } = {}) {
  if (!state.completedBooks.has(bookId)) {
    return;
  }

  state.completedBooks.delete(bookId);
  state.completed.delete(bookId);
  state.completedCount = state.completedBooks.size;
  renderResults();
  updateCounters();
  if (shouldSave) {
    scheduleStateSave();
  }
}

async function loadPersistedState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const payload = JSON.parse(raw);
    const doneBooks = normalizeBooks(payload.done || []);
    const orbitBooks = normalizeBooks(payload.orbit || []);

    for (const book of doneBooks) {
      state.completed.add(book.id);
      state.completedBooks.set(book.id, book);
    }

    for (const book of orbitBooks) {
      if (!state.completed.has(book.id) && !state.orbitBooks.has(book.id)) {
        addOrbitBook(book, { animateEntry: false, showCheck: false });
      }
    }

    rebalanceOrbitAnchors({ snap: true });
    state.completedCount = state.completedBooks.size;
    renderResults();
    updateCounters();
  } catch (error) {
    console.warn("Saved book state could not be loaded.", error);
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function scheduleStateSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(savePersistedState, 250);
}

function savePersistedState() {
  const payload = {
    orbit: [...state.orbitBooks.values()].map((entity) => serializeBook(entity.book)),
    done: [...state.completedBooks.values()].map(serializeBook),
    savedAt: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Keep the UI responsive even if private browsing or quota limits block storage.
  }
}

function serializeBook(book) {
  return {
    id: book.id,
    title: book.title,
    authors: Array.isArray(book.authors) ? book.authors : [],
    publisher: book.publisher || "",
    year: book.year || "",
    status: book.status || "",
    source: book.source || "",
    isMinumsa: Boolean(book.isMinumsa),
    coverUrl: book.coverUrl || "",
    largeCoverUrl: book.largeCoverUrl || book.coverUrl || "",
    detailUrl: book.detailUrl || "",
  };
}

function createResultCover(book) {
  if (!book.coverUrl) {
    return createCoverFallback(book);
  }

  const image = document.createElement("img");
  image.className = "book-result__cover";
  image.src = book.coverUrl;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener(
    "error",
    () => {
      image.replaceWith(createCoverFallback(book));
    },
    { once: true }
  );
  return image;
}

function createCoverFallback(book) {
  const fallback = document.createElement("div");
  fallback.className = "book-result__coverFallback";
  fallback.textContent = initials(book.title);
  return fallback;
}

function createMetaPiece(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function handleResultClick(event) {
  const item = event.target.closest(".book-result");
  if (!item) {
    return;
  }

  const book = state.results.find((candidate) => candidate.id === item.dataset.bookId);
  if (!book || state.completed.has(book.id)) {
    return;
  }

  if (state.orbitBooks.has(book.id)) {
    state.orbitBooks.get(book.id).push();
  } else {
    addOrbitBook(book);
  }

  renderResults();
  updateCounters();
  scheduleStateSave();
  window.setTimeout(() => {
    if (state.orbitBooks.has(book.id)) {
      state.resultsSuppressed = true;
      dom.resultsPanel.hidden = true;
    }
  }, 650);
}

function addOrbitBook(book, { animateEntry = true, showCheck = true } = {}) {
  const placeholder = createBookTexture(book);
  const entity = new OrbitBook(book, placeholder, { animateEntry });
  state.orbitBooks.set(book.id, entity);
  scene.add(entity.group);
  if (showCheck) {
    entity.showCheck();
  }
  rebalanceOrbitAnchors();

  if (book.largeCoverUrl) {
    loadTexture(book.largeCoverUrl, book, book.coverUrl).then((texture) => {
      if (state.orbitBooks.get(book.id) === entity) {
        entity.setCoverTexture(texture);
      }
    });
  }
}

function loadTexture(url, book, fallbackUrl = "") {
  return new Promise((resolve) => {
    textureLoader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        resolve(texture);
      },
      undefined,
      () => {
        if (fallbackUrl && fallbackUrl !== url) {
          loadTexture(fallbackUrl, book).then(resolve);
          return;
        }
        resolve(createBookTexture(book));
      }
    );
  });
}

class OrbitBook {
  constructor(book, coverTexture, { animateEntry = true } = {}) {
    this.book = book;
    this.age = 0;
    this.phase = Math.random() * Math.PI * 2;
    this.seed = Math.random();
    this.state = "orbit";
    this.anchor = createOrbitAnchor(this.seed, 0, 1);
    this.velocity = new THREE.Vector3();
    this.dragging = false;
    this.depthScale = getDepthScale(this.anchor.z);
    this.lineupIndex = 0;
    this.suctionAge = 0;
    this.angularVelocity = new THREE.Vector3(
      randomBetween(-0.55, 0.55),
      randomBetween(-0.75, 0.75),
      randomBetween(-0.25, 0.25)
    );

    this.group = new THREE.Group();
    this.group.position.copy(animateEntry ? randomEdgePosition() : this.anchor);
    this.velocity.copy(this.anchor).sub(this.group.position).multiplyScalar(animateEntry ? 1.08 : 0);
    this.velocity.x += randomBetween(-0.55, 0.55);
    this.velocity.y += randomBetween(-0.32, 0.32);
    this.velocity.z += randomBetween(-0.22, 0.22);

    const bodyMaterial = [
      new THREE.MeshStandardMaterial({ color: 0xe8dfcf, roughness: 0.72 }),
      new THREE.MeshStandardMaterial({ color: 0x20354c, roughness: 0.52, metalness: 0.04 }),
      new THREE.MeshStandardMaterial({ color: 0xf4ecdc, roughness: 0.75 }),
      new THREE.MeshStandardMaterial({ color: 0xddd4c2, roughness: 0.75 }),
      new THREE.MeshStandardMaterial({ color: 0x151b2b, roughness: 0.65 }),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.7 }),
    ];

    this.body = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.6, 0.13, 2, 2, 1), bodyMaterial);
    this.body.userData.orbitBook = this;
    this.group.add(this.body);
    clickTargets.push(this.body);

    this.coverMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: coverTexture,
      roughness: 0.43,
      metalness: 0.02,
    });
    this.cover = new THREE.Mesh(new THREE.PlaneGeometry(1.02, 1.55), this.coverMaterial);
    this.cover.position.z = 0.071;
    this.cover.userData.orbitBook = this;
    this.group.add(this.cover);
    clickTargets.push(this.cover);

    this.backCover = new THREE.Mesh(createBackCoverGeometry(), this.coverMaterial);
    this.backCover.position.z = -0.071;
    this.backCover.rotation.y = Math.PI;
    this.backCover.userData.orbitBook = this;
    this.group.add(this.backCover);
    clickTargets.push(this.backCover);

    this.hitArea = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 18, 18),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    this.hitArea.userData.orbitBook = this;
    this.group.add(this.hitArea);
    clickTargets.push(this.hitArea);

    this.depthHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: createDepthHaloTexture(),
        color: 0xb9f7ff,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.depthHalo.position.set(0, -0.12, -0.18);
    this.depthHalo.scale.set(1.35, 1.8, 1);
    this.group.add(this.depthHalo);

    this.edgeLine = new THREE.Mesh(
      new THREE.BoxGeometry(1.09, 1.64, 0.018),
      new THREE.MeshBasicMaterial({ color: 0x7deeff, transparent: true, opacity: 0.18 })
    );
    this.edgeLine.position.z = 0.081;
    this.edgeLine.scale.set(1.01, 1.01, 1);
    this.group.add(this.edgeLine);

    this.suctionGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: createBookSuctionGlowTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.suctionGlow.renderOrder = 3;
    this.suctionGlow.position.set(0, 0, 0.16);
    this.suctionGlow.scale.set(1.55, 2.25, 1);
    this.group.add(this.suctionGlow);

    this.warpTrail = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: createWarpTrailTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.warpTrail.renderOrder = 2;
    this.warpTrail.position.set(0, -0.08, -0.22);
    this.warpTrail.scale.set(1.7, 2.6, 1);
    this.group.add(this.warpTrail);

    this.suctionLight = new THREE.PointLight(0xbdf8ff, 0, 3.6);
    this.suctionLight.position.set(0, 0, 0.42);
    this.group.add(this.suctionLight);

    this.checkSprite = null;
    this.checkAge = -1;
  }

  setCoverTexture(texture) {
    if (this.coverMaterial.map) {
      this.coverMaterial.map.dispose();
    }
    this.coverMaterial.map = texture;
    this.coverMaterial.needsUpdate = true;
  }

  setOrbitAnchor(index, count, { snap = false } = {}) {
    this.lineupIndex = index;
    this.anchor.copy(createOrbitAnchor(this.seed, index, count));
    if (snap) {
      this.group.position.copy(this.anchor);
      this.velocity.multiplyScalar(0);
      this.group.scale.setScalar(getDepthScale(this.group.position.z));
    }
  }

  setLineupAnchor(index, count, { snap = false } = {}) {
    this.lineupIndex = index;
    this.anchor.copy(createLineupAnchor(index, count));
    if (snap) {
      this.group.position.copy(this.anchor);
      this.velocity.multiplyScalar(0);
      this.group.scale.setScalar(getDepthScale(this.group.position.z));
    }
  }

  startDrag() {
    this.dragging = true;
    this.velocity.multiplyScalar(0.25);
    this.showCheck();
  }

  dragTo(world, dt) {
    const next = world.clone();
    constrainToViewport(next, this.velocity);
    const delta = next.clone().sub(this.group.position);
    this.group.position.addScaledVector(delta, 0.78);
    this.anchor.lerp(this.group.position, 0.55);
    if (dt > 0) {
      this.velocity.copy(delta).multiplyScalar(Math.min(28, 1 / dt));
    }
  }

  endDrag() {
    this.dragging = false;
    this.anchor.copy(this.group.position);
    this.velocity.multiplyScalar(0.68);
    this.angularVelocity.add(new THREE.Vector3(randomBetween(-0.18, 0.18), randomBetween(-0.28, 0.28), randomBetween(-0.1, 0.1)));
  }

  push() {
    const impulse = new THREE.Vector3(randomBetween(-0.9, 0.9), randomBetween(0.35, 1), randomBetween(-0.4, 0.4));
    this.velocity.add(impulse);
    this.showCheck();
  }

  showCheck() {
    this.checkAge = 0;
    if (!this.checkSprite) {
      this.checkSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: createCheckTexture(),
          transparent: true,
          opacity: 0,
          depthTest: false,
        })
      );
      this.checkSprite.scale.set(0.34, 0.34, 0.34);
      this.checkSprite.position.set(0.43, 0.73, 0.18);
      this.group.add(this.checkSprite);
    }
  }

  startSuction() {
    if (this.state === "sucking") {
      return;
    }
    this.state = "sucking";
    this.dragging = false;
    this.suctionAge = 0;
    this.checkAge = -1;
    if (this.checkSprite) {
      this.checkSprite.material.opacity = 0;
    }
    if (this.group.position.length() < 0.92) {
      const angle = this.phase + this.age * 0.8;
      this.group.position.set(Math.cos(angle) * 1.52, Math.sin(angle) * 0.98, randomBetween(0.42, 0.82));
    }
    this.velocity.multiplyScalar(0.4);
    this.velocity.add(new THREE.Vector3(-this.group.position.y, this.group.position.x, 0).normalize().multiplyScalar(0.82));
    this.angularVelocity.multiplyScalar(3.4);
    activateBlackHole(3000);
  }

  update(dt, elapsed, books) {
    this.age += dt;

    if (this.dragging && this.state === "orbit") {
      this.updateDragHover(dt, elapsed);
    } else if (this.state === "sucking") {
      this.updateSuction(dt);
    } else {
      this.updateOrbit(dt, elapsed, books);
    }

    if (!this.dragging) {
      this.group.position.addScaledVector(this.velocity, dt);
    }

    if (this.state === "orbit") {
      this.updateOrbitRotation(dt, elapsed);
      this.updateDepthPresentation(dt);
    } else {
      this.group.rotation.x += (this.angularVelocity.x + Math.sin(elapsed * 0.7 + this.phase) * 0.18) * dt;
      this.group.rotation.y += (this.angularVelocity.y + Math.cos(elapsed * 0.5 + this.phase) * 0.2) * dt;
      this.group.rotation.z += this.angularVelocity.z * dt;
    }

    this.updateCheck(dt);

    if (this.state === "orbit") {
      constrainToViewport(this.group.position, this.velocity);
    }
  }

  updateOrbit(dt, elapsed, books) {
    const isLineup = state.layoutMode === "lineup";
    const driftScale = isLineup ? 0.18 : 1;
    const drift = new THREE.Vector3(
      Math.sin(elapsed * 0.47 + this.phase) * 0.35 * driftScale,
      Math.cos(elapsed * 0.39 + this.phase * 1.31) * 0.26 * driftScale,
      Math.sin(elapsed * 0.33 + this.phase * 0.63) * 0.32 * driftScale
    );
    const target = this.anchor.clone().add(drift);
    const force = target.sub(this.group.position).multiplyScalar(isLineup ? 2.65 : 1.18);
    force.add(this.group.position.clone().multiplyScalar(isLineup ? -0.012 : -0.035));

    for (const other of books) {
      if (other === this || other.state !== "orbit") {
        continue;
      }
      const offset = this.group.position.clone().sub(other.group.position);
      const distance = offset.length();
      const safeDistance = isLineup ? 0.72 : 1.25;
      if (distance > 0.001 && distance < safeDistance) {
        force.add(offset.normalize().multiplyScalar((safeDistance - distance) * (isLineup ? 0.7 : 2.05)));
      }
    }

    this.velocity.addScaledVector(force, dt);
    this.velocity.multiplyScalar(Math.pow(isLineup ? 0.945 : 0.985, dt * 60));

  }

  updateDragHover(dt, elapsed) {
    this.velocity.multiplyScalar(Math.pow(0.82, dt * 60));
    this.group.rotation.x = THREE.MathUtils.damp(this.group.rotation.x, Math.sin(elapsed * 2 + this.phase) * 0.08, 8, dt);
    this.group.rotation.y = THREE.MathUtils.damp(this.group.rotation.y, Math.cos(elapsed * 1.7 + this.phase) * 0.1, 8, dt);
    this.group.rotation.z = THREE.MathUtils.damp(this.group.rotation.z, Math.sin(elapsed * 1.3 + this.phase) * 0.035, 8, dt);
  }

  updateOrbitRotation(dt, elapsed) {
    if (state.layoutMode === "lineup") {
      const targetY = (this.lineupIndex % 2 === 0 ? -0.08 : 0.08) + Math.sin(elapsed * 0.45 + this.phase) * 0.035;
      this.group.rotation.x = THREE.MathUtils.damp(this.group.rotation.x, Math.sin(elapsed * 0.5 + this.phase) * 0.045, 4.5, dt);
      this.group.rotation.y = THREE.MathUtils.damp(this.group.rotation.y, targetY, 4.5, dt);
      this.group.rotation.z = THREE.MathUtils.damp(this.group.rotation.z, Math.sin(elapsed * 0.42 + this.phase) * 0.025, 4.5, dt);
      return;
    }

    this.group.rotation.x += (this.angularVelocity.x + Math.sin(elapsed * 0.7 + this.phase) * 0.18) * dt;
    this.group.rotation.y += (this.angularVelocity.y + Math.cos(elapsed * 0.5 + this.phase) * 0.2) * dt;
    this.group.rotation.z += this.angularVelocity.z * dt;
  }

  updateDepthPresentation(dt) {
    this.depthScale = getDepthScale(this.group.position.z);
    const targetScale = this.depthScale * (this.dragging ? 1.08 : 1);
    this.group.scale.setScalar(THREE.MathUtils.damp(this.group.scale.x, targetScale, 5.5, dt));

    const depth = THREE.MathUtils.clamp((this.group.position.z + viewport.boundsZ) / (viewport.boundsZ * 2), 0, 1);
    this.depthHalo.material.opacity = THREE.MathUtils.lerp(0.06, 0.2, depth) * (this.dragging ? 1.8 : 1);
    this.depthHalo.scale.set(1.2 + depth * 0.45, 1.62 + depth * 0.55, 1);
    this.edgeLine.material.opacity = THREE.MathUtils.lerp(0.09, 0.25, depth);
  }

  updateSuction(dt) {
    this.suctionAge += dt;
    this.depthScale = getDepthScale(this.group.position.z);
    const toCenter = center.clone().sub(this.group.position);
    const distance = Math.max(toCenter.length(), 0.025);
    const inward = toCenter.normalize();
    const tangent = new THREE.Vector3(-inward.y, inward.x, Math.sin(this.suctionAge * 2.6 + this.phase) * 0.22).normalize();
    const progress = THREE.MathUtils.clamp(this.suctionAge / 2.55, 0, 1);
    const pull = (15 + progress * 10) / (distance * distance + 0.28);
    this.velocity.addScaledVector(inward, pull * dt);
    this.velocity.addScaledVector(tangent, ((3.7 + progress * 4.2) / (distance + 0.3)) * dt);
    this.velocity.z += Math.sin(this.suctionAge * 8 + this.phase) * progress * dt * 0.22;
    this.velocity.multiplyScalar(Math.pow(0.988, dt * 60));

    const timeScale = 1 - THREE.MathUtils.smoothstep(this.suctionAge, 1.45, 2.55) * 0.95;
    const proximityScale = Math.sqrt(THREE.MathUtils.clamp((distance - 0.1) / 1.15, 0.06, 1));
    const scale = THREE.MathUtils.clamp(Math.min(proximityScale, timeScale), 0.045, 1);
    this.group.scale.setScalar(this.depthScale * scale);
    this.updateSuctionGlow(distance, scale, progress);

    if ((distance < 0.14 || scale < 0.05 || this.suctionAge > 2.55) && this.suctionAge > 1.15) {
      completeBook(this);
    }
  }

  updateSuctionGlow(distance, bookScale, progress) {
    const ignition = THREE.MathUtils.smoothstep(this.suctionAge, 0, 0.35);
    const fade = 1 - THREE.MathUtils.smoothstep(this.suctionAge, 2.14, 2.55);
    const gravityBoost = THREE.MathUtils.clamp(1.55 / (distance + 0.38), 0.85, 2.8);
    const flicker = 0.88 + Math.sin(this.suctionAge * 36 + this.phase) * 0.12 + Math.sin(this.suctionAge * 91) * 0.04;
    const intensity = ignition * fade * flicker;
    const compensatedScale = Math.max(Math.sqrt(bookScale), 0.32);
    const glowWidth = (1.5 + gravityBoost * 0.24 + progress * 0.34) / compensatedScale;
    const glowHeight = (2.22 + gravityBoost * 0.3 + progress * 0.52) / compensatedScale;

    this.suctionGlow.material.opacity = intensity * 0.72;
    this.suctionGlow.scale.set(glowWidth, glowHeight, 1);
    this.warpTrail.material.opacity = intensity * (0.24 + progress * 0.34);
    this.warpTrail.scale.set((1.85 + progress * 0.9) / compensatedScale, (2.7 + progress * 1.8) / compensatedScale, 1);
    this.warpTrail.material.rotation = -this.group.rotation.z + this.suctionAge * 0.7;
    this.suctionLight.intensity = intensity * (2.4 + gravityBoost * 1.05);
  }

  updateCheck(dt) {
    if (!this.checkSprite || this.checkAge < 0) {
      return;
    }
    this.checkAge += dt;
    const opacity = this.checkAge < 0.35 ? this.checkAge / 0.35 : Math.max(0, 1 - (this.checkAge - 0.35) / 0.75);
    this.checkSprite.material.opacity = opacity;
    this.checkSprite.scale.setScalar(0.28 + opacity * 0.1);

    if (this.checkAge > 1.1) {
      this.checkAge = -1;
      this.checkSprite.material.opacity = 0;
    }
  }

  destroy() {
    removeClickTarget(this.body);
    removeClickTarget(this.cover);
    removeClickTarget(this.backCover);
    removeClickTarget(this.hitArea);
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    const disposedTextures = new Set();

    this.group.traverse((object) => {
      if (object.geometry && !disposedGeometries.has(object.geometry)) {
        object.geometry.dispose();
        disposedGeometries.add(object.geometry);
      }
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material.map && !disposedTextures.has(material.map)) {
            material.map.dispose();
            disposedTextures.add(material.map);
          }
          if (!disposedMaterials.has(material)) {
            material.dispose();
            disposedMaterials.add(material);
          }
        }
      }
    });
    scene.remove(this.group);
  }
}

function completeBook(entity) {
  if (!state.orbitBooks.has(entity.book.id)) {
    return;
  }

  entity.destroy();
  state.orbitBooks.delete(entity.book.id);
  state.completed.add(entity.book.id);
  state.completedBooks.set(entity.book.id, entity.book);
  state.completedCount = state.completedBooks.size;
  triggerBlackHoleBloom();
  renderResults();
  updateCounters();
  scheduleStateSave();
}

function handleScenePointerDown(event) {
  pointerDown.set(event.clientX, event.clientY);
  if (dom.modal.hidden === false) {
    return;
  }

  const entity = pickOrbitBook(event);
  if (!entity || entity.state !== "orbit") {
    return;
  }

  if (state.layoutMode === "lineup") {
    setLayoutMode("orbit");
  }

  const world = screenToWorld(event, entity.group.position.z);
  state.dragging = {
    entity,
    lastTime: performance.now(),
    lastWorld: world,
    moved: false,
    offset: entity.group.position.clone().sub(world),
    pointerId: event.pointerId,
  };
  entity.startDrag();
  dom.sceneHost.classList.add("is-dragging");
  renderer.domElement.setPointerCapture?.(event.pointerId);
}

function handleScenePointerMove(event) {
  if (!state.dragging || state.dragging.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  const drag = state.dragging;
  const now = performance.now();
  const dt = Math.max((now - drag.lastTime) / 1000, 0.001);
  const world = screenToWorld(event, drag.entity.group.position.z).add(drag.offset);
  drag.entity.dragTo(world, dt);
  drag.lastWorld.copy(world);
  drag.lastTime = now;
  drag.moved = drag.moved || pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 7;
}

function handleScenePointerUp(event) {
  if (state.dragging && state.dragging.pointerId === event.pointerId) {
    const entity = state.dragging.entity;
    const wasMoved = endSceneDrag(event);
    if (!wasMoved && dom.modal.hidden !== false && entity.state === "orbit") {
      openModal(entity);
    }
    return;
  }

  const dragDistance = pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
  if (dragDistance > 8 || dom.modal.hidden === false) {
    return;
  }

  openBookAtPointer(event);
}

function handleSceneClick(event) {
  if (state.suppressSceneClick) {
    state.suppressSceneClick = false;
    return;
  }

  if (dom.modal.hidden === false) {
    return;
  }

  openBookAtPointer(event);
}

function handleScenePointerCancel(event) {
  if (state.dragging?.pointerId === event.pointerId) {
    endSceneDrag(event, true);
  }
}

function endSceneDrag(event, cancel = false) {
  const drag = state.dragging;
  if (!drag) {
    return false;
  }

  drag.entity.endDrag();
  state.dragging = null;
  dom.sceneHost.classList.remove("is-dragging");
  if (event?.pointerId !== undefined) {
    renderer.domElement.releasePointerCapture?.(event.pointerId);
  }
  state.suppressSceneClick = drag.moved || cancel;
  return drag.moved;
}

function openBookAtPointer(event) {
  const entity = pickOrbitBook(event);
  if (entity) {
    openModal(entity);
  }
}

function pickOrbitBook(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(clickTargets, false);
  const hit = hits.find((entry) => entry.object.userData.orbitBook?.state === "orbit");

  return hit?.object.userData.orbitBook || null;
}

function screenToWorld(event, z) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  const world = new THREE.Vector3(pointer.x, pointer.y, 0.5).unproject(camera);
  const direction = world.sub(camera.position).normalize();
  const distance = (z - camera.position.z) / direction.z;
  return camera.position.clone().addScaledVector(direction, distance);
}

function openModal(entity) {
  state.activeModalBook = entity;
  dom.modalTitle.textContent = entity.book.title;
  dom.modalAuthor.textContent = [entity.book.authors.length ? entity.book.authors.join(", ") : "작가 미상", entity.book.publisher]
    .filter(Boolean)
    .join(" · ");
  dom.modalCover.src = entity.book.coverUrl || createCoverDataUrl(entity.book);
  dom.modalCover.alt = "";
  dom.modal.hidden = false;
  dom.modalConfirm.focus();
}

function closeModal({ restoreFocus = true } = {}) {
  dom.modal.hidden = true;
  state.activeModalBook = null;
  if (restoreFocus) {
    dom.query.focus({ preventScroll: true });
  }
}

function confirmCompleted() {
  const entity = state.activeModalBook;
  closeModal({ restoreFocus: false });
  if (entity && state.orbitBooks.get(entity.book.id) === entity) {
    state.resultsSuppressed = true;
    dom.resultsPanel.hidden = true;
    entity.startSuction();
  }
}

function updateCounters() {
  dom.orbitCount.textContent = String(state.orbitBooks.size);
  dom.doneCount.textContent = String(state.completedBooks.size);
  renderSideLists();
}

function animate() {
  const dt = Math.min(clock.getDelta(), 0.033);
  const elapsed = clock.elapsedTime;
  const books = [...state.orbitBooks.values()];

  starField.rotation.y += dt * 0.006;
  starField.rotation.x = Math.sin(elapsed * 0.05) * 0.025;

  for (const book of books) {
    book.update(dt, elapsed, books);
  }

  updateBlackHole(dt, elapsed, books.some((book) => book.state === "sucking"));
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function updateBlackHole(dt, elapsed, isSucking) {
  const now = performance.now();
  const shouldShow = isSucking || now < blackHoleActiveUntil;
  blackHole.group.visible = shouldShow;
  if (!shouldShow) {
    return;
  }

  const age = Math.max(0, (now - blackHole.startedAt) / 1000);
  const intro = easeOutCubic(THREE.MathUtils.clamp(age / 0.42, 0, 1));
  const outro = isSucking ? 1 : THREE.MathUtils.clamp((blackHoleActiveUntil - now) / 1500, 0, 1);
  const bloom = THREE.MathUtils.clamp(1 - (now - blackHole.bloomAt) / 620, 0, 1);
  const intensity = intro * (isSucking ? 1 : outro);
  const pulse = 1 + Math.sin(elapsed * 5.7) * 0.035 + bloom * 0.18;

  blackHole.group.scale.setScalar((0.52 + intro * 0.48 + bloom * 0.14) * Math.max(0.45, outro));
  blackHole.core.scale.setScalar(pulse);
  blackHole.disk.rotation.z += dt * (1.55 + intensity * 1.1);
  blackHole.disk2.rotation.z -= dt * (0.9 + intensity * 0.85);
  blackHole.ring.rotation.z += dt * (3.2 + bloom * 2.5);
  blackHole.ring2.rotation.z -= dt * 2.1;
  blackHole.particles.rotation.z += dt * (0.65 + intensity * 1.2);
  blackHole.particles.rotation.x = Math.sin(elapsed * 0.5) * 0.08;
  blackHole.glow.material.opacity = (0.16 + intensity * 0.24 + bloom * 0.22) * outro;
  blackHole.corona.material.opacity = (0.22 + intensity * 0.18 + bloom * 0.28) * outro;
  blackHole.disk.material.opacity = (0.5 + intensity * 0.32 + bloom * 0.16) * outro;
  blackHole.disk2.material.opacity = (0.25 + intensity * 0.18) * outro;
  blackHole.particles.material.opacity = (0.32 + intensity * 0.22) * outro;
  blackHole.light.intensity = (2.2 + intensity * 2.3 + bloom * 3.4) * outro;
}

function activateBlackHole(duration = 2500) {
  const now = performance.now();
  blackHole.group.visible = true;
  blackHole.startedAt = now;
  blackHoleActiveUntil = now + duration;
}

function triggerBlackHoleBloom() {
  const now = performance.now();
  blackHole.bloomAt = now;
  blackHoleActiveUntil = Math.max(blackHoleActiveUntil, now + 1500);
}

function resizeScene() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewport = getViewport();
  rebalanceOrbitAnchors();
}

function getViewport() {
  const distance = camera.position.z;
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance;
  const visibleWidth = visibleHeight * camera.aspect;
  return {
    width: visibleWidth,
    height: visibleHeight,
    orbitX: Math.min(visibleWidth * 0.23, 2.35),
    orbitY: Math.min(visibleHeight * 0.2, 1.35),
    boundsX: Math.max(0.95, visibleWidth * 0.42),
    boundsY: Math.max(1.45, visibleHeight * 0.42),
    boundsZ: 2.25,
  };
}

function createStarField() {
  const geometry = new THREE.BufferGeometry();
  const starCount = 1800;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const color = new THREE.Color();

  for (let i = 0; i < starCount; i += 1) {
    const radius = randomBetween(10, 58);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(randomBetween(-1, 1));
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);

    const palette = Math.random();
    if (palette < 0.62) {
      color.setRGB(0.78, 0.92, 1);
    } else if (palette < 0.82) {
      color.setRGB(1, 0.78, 0.5);
    } else {
      color.setRGB(0.82, 0.58, 1);
    }
    const intensity = randomBetween(0.45, 1);
    colors[i * 3] = color.r * intensity;
    colors[i * 3 + 1] = color.g * intensity;
    colors[i * 3 + 2] = color.b * intensity;
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.035,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    })
  );
}

function createBlackHole() {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 1;

  const glowTexture = createGlowTexture();
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xff9c5b,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.scale.set(4.2, 4.2, 1);
  group.add(glow);

  const corona = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: createCoronaTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  corona.scale.set(2.38, 2.38, 1);
  group.add(corona);

  const disk = new THREE.Mesh(
    new THREE.PlaneGeometry(3.55, 1.26),
    new THREE.MeshBasicMaterial({
      map: createAccretionDiskTexture(),
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
  );
  disk.rotation.z = -0.2;
  group.add(disk);

  const disk2 = new THREE.Mesh(
    new THREE.PlaneGeometry(2.75, 0.82),
    new THREE.MeshBasicMaterial({
      map: createAccretionDiskTexture({ inner: "rgba(117, 242, 255, 0.76)", mid: "rgba(255, 255, 255, 0.2)", outer: "rgba(255, 111, 145, 0)" }),
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
  );
  disk2.rotation.z = 0.46;
  group.add(disk2);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  group.add(core);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.74, 0.035, 16, 160),
    new THREE.MeshBasicMaterial({
      color: 0xffb45f,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
    })
  );
  ring.rotation.x = Math.PI * 0.54;
  group.add(ring);

  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.014, 12, 160),
    new THREE.MeshBasicMaterial({
      color: 0x73f2ff,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    })
  );
  ring2.rotation.x = Math.PI * 0.5;
  ring2.rotation.y = Math.PI * 0.1;
  group.add(ring2);

  const particles = createBlackHoleParticles();
  group.add(particles);

  const light = new THREE.PointLight(0xffa057, 2.8, 5.6);
  light.position.set(0, 0, 0.8);
  group.add(light);

  return {
    bloomAt: -Infinity,
    core,
    corona,
    disk,
    disk2,
    glow,
    group,
    light,
    particles,
    ring,
    ring2,
    startedAt: 0,
  };
}

function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(128, 128, 12, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255, 232, 169, 0.95)");
  gradient.addColorStop(0.24, "rgba(255, 151, 73, 0.46)");
  gradient.addColorStop(0.62, "rgba(117, 242, 255, 0.16)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createCoronaTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createRadialGradient(128, 128, 26, 128, 128, 126);
  gradient.addColorStop(0, "rgba(255, 247, 219, 0)");
  gradient.addColorStop(0.32, "rgba(255, 190, 104, 0.72)");
  gradient.addColorStop(0.42, "rgba(112, 239, 255, 0.34)");
  gradient.addColorStop(0.67, "rgba(255, 111, 145, 0.12)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);

  ctx.save();
  ctx.translate(128, 128);
  for (let i = 0; i < 18; i += 1) {
    ctx.rotate((Math.PI * 2) / 18);
    ctx.strokeStyle = `rgba(255, ${170 + (i % 3) * 22}, 116, 0.16)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(28, 0);
    ctx.quadraticCurveTo(68, -8 - (i % 4) * 3, 120, 0);
    ctx.stroke();
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createAccretionDiskTexture({
  inner = "rgba(255, 241, 189, 0.95)",
  mid = "rgba(255, 160, 84, 0.52)",
  outer = "rgba(117, 242, 255, 0)",
} = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  ctx.translate(256, 96);

  const gradient = ctx.createRadialGradient(0, 0, 18, 0, 0, 250);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(0.17, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(0.25, inner);
  gradient.addColorStop(0.42, mid);
  gradient.addColorStop(0.72, "rgba(117, 242, 255, 0.14)");
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(-256, -96, 512, 192);

  for (let i = 0; i < 58; i += 1) {
    const radius = randomBetween(66, 238);
    const y = randomBetween(-13, 13);
    const length = randomBetween(14, 42);
    const alpha = randomBetween(0.08, 0.32);
    ctx.strokeStyle = `rgba(255, ${185 + Math.floor(Math.random() * 45)}, ${110 + Math.floor(Math.random() * 60)}, ${alpha})`;
    ctx.lineWidth = randomBetween(0.7, 1.8);
    ctx.beginPath();
    ctx.moveTo(-radius, y);
    ctx.lineTo(-radius + length, y + randomBetween(-2, 2));
    ctx.moveTo(radius, -y);
    ctx.lineTo(radius - length, -y + randomBetween(-2, 2));
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
  ctx.beginPath();
  ctx.ellipse(0, 0, 50, 23, 0, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBlackHoleParticles() {
  const count = 220;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    const radius = randomBetween(0.62, 1.95);
    const angle = Math.random() * Math.PI * 2;
    const lane = randomBetween(-0.22, 0.22);
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius * 0.38 + lane;
    positions[i * 3 + 2] = randomBetween(-0.1, 0.1);

    if (Math.random() > 0.38) {
      color.set(0xffb66d);
    } else {
      color.set(0x7df3ff);
    }
    const intensity = randomBetween(0.55, 1);
    colors[i * 3] = color.r * intensity;
    colors[i * 3 + 1] = color.g * intensity;
    colors[i * 3 + 2] = color.b * intensity;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.028,
      vertexColors: true,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
}

function createBookSuctionGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(128, 128, 10, 128, 128, 124);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.34)");
  gradient.addColorStop(0.18, "rgba(170, 251, 255, 0.42)");
  gradient.addColorStop(0.44, "rgba(255, 205, 121, 0.2)");
  gradient.addColorStop(0.7, "rgba(112, 232, 255, 0.08)");
  gradient.addColorStop(0.92, "rgba(112, 232, 255, 0)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(128, 128);
  ctx.rotate(-0.22);
  ctx.strokeStyle = "rgba(255, 245, 196, 0.34)";
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.ellipse(0, 0, 64, 94, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createDepthHaloTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(128, 128, 18, 128, 128, 124);
  gradient.addColorStop(0, "rgba(160, 247, 255, 0.28)");
  gradient.addColorStop(0.42, "rgba(128, 236, 255, 0.14)");
  gradient.addColorStop(0.74, "rgba(255, 184, 95, 0.06)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createWarpTrailTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 384;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(128, 0, 128, 384);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0)");
  gradient.addColorStop(0.22, "rgba(173, 250, 255, 0.52)");
  gradient.addColorStop(0.5, "rgba(255, 211, 135, 0.28)");
  gradient.addColorStop(1, "rgba(255, 111, 145, 0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(128, 8);
  ctx.bezierCurveTo(184, 92, 178, 270, 138, 376);
  ctx.bezierCurveTo(108, 296, 78, 96, 128, 8);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(128, 30);
  ctx.bezierCurveTo(146, 120, 112, 212, 134, 342);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBackCoverGeometry() {
  const geometry = new THREE.PlaneGeometry(1.02, 1.55);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setX(i, 1 - uv.getX(i));
  }
  uv.needsUpdate = true;
  return geometry;
}

function createBookTexture(book) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 768;
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 512, 768);
  gradient.addColorStop(0, "#17243a");
  gradient.addColorStop(0.52, "#243a49");
  gradient.addColorStop(1, "#151520");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 768);

  ctx.fillStyle = "rgba(128, 236, 255, 0.14)";
  ctx.fillRect(34, 40, 18, 688);

  ctx.strokeStyle = "rgba(255, 184, 95, 0.42)";
  ctx.lineWidth = 3;
  ctx.strokeRect(58, 70, 396, 628);

  ctx.fillStyle = "rgba(246, 251, 255, 0.92)";
  ctx.font = '700 42px "Segoe UI", "Noto Sans KR", sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  drawWrappedText(ctx, book.title, 88, 142, 340, 58, 6);

  ctx.fillStyle = "rgba(255, 184, 95, 0.9)";
  ctx.font = '700 24px "Segoe UI", "Noto Sans KR", sans-serif';
  drawWrappedText(ctx, book.authors.join(", ") || "Unknown Author", 88, 604, 340, 34, 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function createCoverDataUrl(book) {
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 180, 256);
  gradient.addColorStop(0, "#17243a");
  gradient.addColorStop(1, "#151520");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 180, 256);
  ctx.strokeStyle = "rgba(255, 184, 95, 0.46)";
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 20, 144, 216);
  ctx.fillStyle = "rgba(246, 251, 255, 0.9)";
  ctx.font = '700 22px "Segoe UI", "Noto Sans KR", sans-serif';
  drawWrappedText(ctx, book.title, 30, 58, 120, 30, 4);
  return canvas.toDataURL("image/png");
}

function createCheckTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(8, 18, 22, 0.72)";
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(95, 241, 182, 0.92)";
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = "#5ff1b6";
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(38, 66);
  ctx.lineTo(56, 84);
  ctx.lineTo(92, 44);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const tokens = tokenizeText(text);
  const lines = [];
  let line = "";

  for (const token of tokens) {
    const testLine = line ? `${line}${token}` : token.trimStart();
    if (ctx.measureText(testLine).width > maxWidth && line) {
      lines.push(line.trim());
      line = token.trimStart();
    } else {
      line = testLine;
    }
  }

  if (line) {
    lines.push(line.trim());
  }

  const visibleLines = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    visibleLines[maxLines - 1] = `${visibleLines[maxLines - 1].replace(/\s+$/, "")}...`;
  }

  visibleLines.forEach((visibleLine, index) => {
    ctx.fillText(visibleLine, x, y + index * lineHeight);
  });
}

function tokenizeText(text) {
  const hasWhitespace = /\s/.test(text);
  if (hasWhitespace) {
    return text.split(/(\s+)/).filter(Boolean);
  }
  return [...text];
}

function initials(text) {
  const clean = text.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (!clean) {
    return "BOOK";
  }
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return [...words[0]].slice(0, 3).join("").toUpperCase();
  }
  return words
    .slice(0, 3)
    .map((word) => [...word][0])
    .join("")
    .toUpperCase();
}

function normalizeText(text) {
  return String(text || "")
    .toLocaleLowerCase("ko-KR")
    .replace(/\s+/g, " ")
    .trim();
}

function randomEdgePosition() {
  const fromSide = Math.random() > 0.5;
  const x = fromSide ? (Math.random() > 0.5 ? viewport.boundsX + 1.6 : -viewport.boundsX - 1.6) : randomBetween(-viewport.boundsX, viewport.boundsX);
  const y = fromSide ? randomBetween(-viewport.boundsY, viewport.boundsY) : Math.random() > 0.5 ? viewport.boundsY + 1.2 : -viewport.boundsY - 1.2;
  return new THREE.Vector3(x, y, randomBetween(-viewport.boundsZ * 0.9, viewport.boundsZ * 0.9));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function createOrbitAnchor(seed, index, count) {
  const preset = createPresetOrbitAnchor(index, count, seed);
  if (preset) {
    return preset;
  }

  const golden = Math.PI * (3 - Math.sqrt(5));
  const progress = count <= 1 ? 0.5 : index / Math.max(1, count - 1);
  const radius = Math.sqrt((index + 0.72) / Math.max(1, count));
  const angle = index * golden + seed * Math.PI * 2;
  const depthLane = ((index * 3) % 7) / 6;
  const x = Math.cos(angle) * viewport.orbitX * (0.28 + radius * 0.56) + Math.sin(seed * 11) * 0.16;
  const y = -0.22 + Math.sin(angle) * viewport.orbitY * (0.3 + radius * 0.54) + Math.cos(seed * 7) * 0.12;
  const z = THREE.MathUtils.lerp(viewport.boundsZ * 0.58, -viewport.boundsZ * 0.76, depthLane) + Math.sin(progress * Math.PI * 2 + seed) * 0.14;
  return new THREE.Vector3(x, THREE.MathUtils.clamp(y, -viewport.orbitY * 1.25, viewport.orbitY * 0.6), z);
}

function createPresetOrbitAnchor(index, count, seed) {
  const presets = {
    1: [[0, -0.12, 0.15]],
    2: [
      [-0.78, -0.12, 0.52],
      [0.82, 0.08, -0.68],
    ],
    3: [
      [-1.04, -0.22, -0.34],
      [0.06, 0.26, -0.92],
      [1.08, -0.08, 0.58],
    ],
    4: [
      [-1.16, 0.08, -0.76],
      [-0.42, -0.5, 0.58],
      [0.5, 0.24, -0.22],
      [1.18, -0.3, 0.82],
    ],
    5: [
      [-1.2, 0.08, -0.82],
      [-0.58, -0.52, 0.54],
      [0, 0.24, -0.34],
      [0.68, -0.3, 0.86],
      [1.22, 0.1, -0.58],
    ],
  };
  const slots = presets[count];
  if (!slots) {
    return null;
  }

  const [slotX, slotY, slotZ] = slots[index];
  const xScale = Math.min(1.18, Math.max(0.72, viewport.orbitX / 1.42));
  const yScale = Math.min(1.08, Math.max(0.76, viewport.orbitY / 1.02));
  const jitterX = Math.sin(seed * 17) * 0.04;
  const jitterY = Math.cos(seed * 13) * 0.035;
  return new THREE.Vector3(slotX * xScale + jitterX, slotY * yScale + jitterY, slotZ);
}

function createLineupAnchor(index, count) {
  const visibleCount = Math.max(1, count);
  const maxColumns = Math.min(visibleCount, window.innerWidth < 700 ? 4 : 7);
  const row = Math.floor(index / maxColumns);
  const column = index % maxColumns;
  const columnsInRow = Math.min(maxColumns, visibleCount - row * maxColumns);
  const centered = column - (columnsInRow - 1) / 2;
  const xSpacing = Math.min(0.86, viewport.width / (maxColumns + 2));
  const y = -row * 0.86 + (row > 0 ? -0.08 : 0) + Math.sin(index * 0.7) * 0.035;
  const z = THREE.MathUtils.clamp(0.92 - row * 0.48 - Math.abs(centered) * 0.06, -1.25, 1.05);
  return new THREE.Vector3(centered * xSpacing, y, z);
}

function getDepthScale(z) {
  const depth = THREE.MathUtils.clamp((z + viewport.boundsZ) / (viewport.boundsZ * 2), 0, 1);
  return THREE.MathUtils.lerp(0.82, 1.06, depth);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function constrainToViewport(position, velocity) {
  constrainAxis(position, velocity, viewport.boundsX, "x");
  constrainAxis(position, velocity, viewport.boundsY, "y");
  constrainAxis(position, velocity, viewport.boundsZ, "z");
}

function constrainAxis(position, velocity, bounds, axis) {
  if (position[axis] > bounds) {
    position[axis] = bounds;
    if (velocity[axis] > 0) {
      velocity[axis] *= -0.52;
    }
  } else if (position[axis] < -bounds) {
    position[axis] = -bounds;
    if (velocity[axis] < 0) {
      velocity[axis] *= -0.52;
    }
  }
}

function removeClickTarget(target) {
  const index = clickTargets.indexOf(target);
  if (index >= 0) {
    clickTargets.splice(index, 1);
  }
}
