const templateHeader = document.querySelector("#templateHeader");
const templateGrid = document.querySelector("#templateGrid");
const generatorCards = document.querySelectorAll(".generator-card");
const promptScreen = document.querySelector("#promptScreen");
const backToTemplates = document.querySelector("#backToTemplates");
const generateVideoButton = document.querySelector("#generateVideo");
const videoPrompt = document.querySelector("#videoPrompt");
const loadingScreen = document.querySelector("#loadingScreen");
const videoScreen = document.querySelector("#videoScreen");
const backToPrompt = document.querySelector("#backToPrompt");
const resultVideo = document.querySelector("#resultVideo");
const downloadButton = document.querySelector("#downloadButton");
const promptKicker = document.querySelector("#promptKicker");
const promptTitle = document.querySelector("#promptTitle");
const promptDescription = document.querySelector("#promptDescription");
const promptHelpList = document.querySelector("#promptHelpList");
const videoTitle = document.querySelector("#videoTitle");
const errorPanel = document.querySelector("#errorPanel");
const errorStage = document.querySelector("#errorStage");
const errorTitle = document.querySelector("#errorTitle");
const errorMessage = document.querySelector("#errorMessage");
const errorSuggestion = document.querySelector("#errorSuggestion");
const errorDetail = document.querySelector("#errorDetail");
const errorDetailRow = document.querySelector("#errorDetailRow");
const errorTrace = document.querySelector("#errorTrace");
const errorTraceRow = document.querySelector("#errorTraceRow");
const loadingStatus = document.querySelector("#loadingStatus");

let activeFlow = {
  id: "leaderboard",
  title: "Leaderboard",
  description: "",
};

function hideAllScreens() {
  templateHeader.classList.add("is-hidden");
  templateGrid.classList.add("is-hidden");
  promptScreen.classList.add("is-hidden");
  loadingScreen.classList.add("is-hidden");
  videoScreen.classList.add("is-hidden");
}

function showTemplateGrid() {
  hideAllScreens();
  templateHeader.classList.remove("is-hidden");
  templateGrid.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderHelpList(helpText) {
  const items = String(helpText || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  promptHelpList.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    promptHelpList.append(li);
  }
}

function showPromptScreen(card) {
  activeFlow = {
    id: card.dataset.flow,
    title: card.dataset.title,
    description: card.dataset.description,
  };

  promptKicker.textContent =
    activeFlow.id === "custom-data" ? "Advanced pipeline" : "Generate video";
  promptTitle.textContent = activeFlow.title;
  promptDescription.textContent = activeFlow.description;
  videoPrompt.placeholder = card.dataset.placeholder || "";
  videoTitle.textContent = `${activeFlow.title} Preview`;
  renderHelpList(card.dataset.help);
  hideError();

  hideAllScreens();
  promptScreen.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function hideError() {
  errorPanel.classList.add("is-hidden");
  errorDetailRow.classList.add("is-hidden");
  errorTraceRow.classList.add("is-hidden");
}

function showError(error) {
  const payload = error?.payload?.error || {};
  const stage = payload.stage || "unknown";
  errorStage.textContent = `Generation issue · ${stage}`;
  errorTitle.textContent = payload.code || "Video not generated";
  errorMessage.textContent = payload.message || error.message || "Something went wrong while creating the video.";
  errorSuggestion.textContent =
    payload.suggestion || "Try again with a shorter prompt, or check the server logs for the failing stage.";

  if (payload.detail) {
    errorDetail.textContent = payload.detail;
    errorDetailRow.classList.remove("is-hidden");
  } else {
    errorDetailRow.classList.add("is-hidden");
  }

  if (payload.traceId) {
    errorTrace.textContent = payload.traceId;
    errorTraceRow.classList.remove("is-hidden");
  } else {
    errorTraceRow.classList.add("is-hidden");
  }

  errorPanel.classList.remove("is-hidden");
}

async function parseErrorResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        code: "UPSTREAM_ERROR",
        message: text || "The server returned a non-JSON error.",
        stage: "deployment",
        suggestion: "Check Railway logs, request timeout, and whether the server process restarted during generation.",
      },
    };
  }
}

async function generateVideo() {
  const prompt = videoPrompt.value.trim();
  if (!prompt) {
    videoPrompt.focus();
    return;
  }

  hideAllScreens();
  hideError();
  loadingScreen.classList.remove("is-hidden");
  loadingStatus.textContent =
    "We are turning your prompt into a composition, then rendering it into a video.";
  window.scrollTo({ top: 0, behavior: "smooth" });
  const slowTimer = setTimeout(() => {
    loadingStatus.textContent =
      "Still working. If this fails, the next screen will show whether OpenAI, HyperFrames, ffmpeg, or deployment timed out.";
  }, 25_000);

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        flow: activeFlow.id,
        prompt,
      }),
    });

    if (!response.ok) {
      const payload = await parseErrorResponse(response);
      const error = new Error(payload?.error?.message || "Video generation failed");
      error.payload = payload;
      throw error;
    }

    const result = await response.json();
    resultVideo.src = result.videoUrl;
    downloadButton.href = result.videoUrl;
    downloadButton.download = `${activeFlow.id}-video.mp4`;

    hideAllScreens();
    videoScreen.classList.remove("is-hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    hideAllScreens();
    promptScreen.classList.remove("is-hidden");
    showError(error);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    clearTimeout(slowTimer);
  }
}

for (const card of generatorCards) {
  card.addEventListener("click", () => showPromptScreen(card));
}

backToTemplates.addEventListener("click", showTemplateGrid);
generateVideoButton.addEventListener("click", generateVideo);
backToPrompt.addEventListener("click", () => {
  hideAllScreens();
  promptScreen.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
