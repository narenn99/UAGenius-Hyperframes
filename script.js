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

  hideAllScreens();
  promptScreen.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function generateVideo() {
  const prompt = videoPrompt.value.trim();
  if (!prompt) {
    videoPrompt.focus();
    return;
  }

  hideAllScreens();
  loadingScreen.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

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
      throw new Error("Video generation failed");
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
    alert(error.message || "Video generation failed. Please try again.");
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
