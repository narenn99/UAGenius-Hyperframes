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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollGenerationJob(statusUrl) {
  const startedAt = Date.now();
  const clientTimeoutMs = 10 * 60 * 1000 + 30 * 1000;
  let statusReadFailures = 0;

  while (Date.now() - startedAt < clientTimeoutMs) {
    await wait(2500);
    let response;
    try {
      response = await fetch(statusUrl);
    } catch {
      statusReadFailures += 1;
      if (statusReadFailures <= 12) {
        loadingStatus.textContent =
          "Generation is still running. Reconnecting to the status endpoint...";
        continue;
      }

      const error = new Error("Could not read generation status");
      error.payload = {
        error: {
          code: "STATUS_UNREACHABLE",
          message: "Could not read generation status after several retries.",
          stage: "status",
          suggestion: "The video may still be generating. Wait a moment, then try again or refresh the page.",
        },
      };
      throw error;
    }

    if (!response.ok) {
      const payload = await parseErrorResponse(response);
      if (payload?.error?.code === "JOB_NOT_FOUND" && statusReadFailures <= 6) {
        statusReadFailures += 1;
        loadingStatus.textContent =
          "Generation is still running. Waiting for job status to become available...";
        continue;
      }

      const error = new Error(payload?.error?.message || "Could not read generation status");
      error.payload = payload;
      throw error;
    }

    statusReadFailures = 0;
    const job = await response.json();
    if (job.status === "running" || job.status === "queued") {
      loadingStatus.textContent = job.message || `Still working: ${job.stage || "generation"}`;
      continue;
    }

    if (job.status === "succeeded" && job.result) {
      return job.result;
    }

    const error = new Error(job.error?.message || "Video generation failed");
    error.payload = { error: job.error || { stage: job.stage || "unknown" } };
    throw error;
  }

  const error = new Error("Generation exceeded the 10-minute client wait limit.");
  error.payload = {
    error: {
      code: "CLIENT_TIMEOUT",
      message: error.message,
      stage: "generation",
      suggestion: "Check the job status and Railway logs. The server may still be working or may have hit the 10-minute cap.",
    },
  };
  throw error;
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
    "Generation started. Waiting for OpenAI to create the composition, then rendering it into a video.";
  window.scrollTo({ top: 0, behavior: "smooth" });
  const slowTimer = setTimeout(() => {
    loadingStatus.textContent =
      "Still working. Some prompts take longer; this job will keep polling and only fail after the 10-minute safety limit or a real subsystem error.";
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

    let result = await response.json();
    if (response.status === 202 && result.statusUrl) {
      loadingStatus.textContent =
        result.message || "Generation started. Waiting for OpenAI and the renderer to finish.";
      result = await pollGenerationJob(result.statusUrl);
    }

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
