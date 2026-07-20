document.getElementById("year").textContent = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Chat thread content
// ---------------------------------------------------------------------------
const THREADS = {
  hero: [
    { from: "user", text: "Remind me to call mum when I leave work", time: "5:41 PM" },
    { from: "ping", text: "Got it — I'll ping you the moment you're heading out.", time: "5:41 PM" },
    { from: "user", text: "What should I get Sarah for her birthday?", time: "6:02 PM" },
    { from: "ping", text: "A pottery class gift card? You mentioned she loved the one in Shoreditch last month 🏺", time: "6:02 PM" },
  ],
  memory: [
    { from: "user", text: "My girlfriend Laure's birthday is March 3rd", time: "11:02 AM" },
    { from: "ping", text: "Noted — I'll remember that.", time: "11:02 AM" },
    { from: "user", text: "Recommend somewhere nice for Laure's birthday", time: "Feb 27" },
    { from: "ping", text: "How about that Italian place near you she mentioned wanting to try? Or something with a view, since it's a big one — 6 years together?", time: "Feb 27" },
  ],
  "remind-friend": [
    { from: "user", text: "Remind Alex tomorrow to send over the deck", time: "9:14 AM" },
    { from: "ping", text: "Don't have Alex's number yet — what is it?", time: "9:14 AM" },
    { from: "user", text: "+44 7911 123456", time: "9:15 AM" },
    { from: "ping", text: "Done. I'll ping him tomorrow morning.", time: "9:15 AM" },
    { from: "ping", text: "Alex replied: \"sending now, sorry for the delay 🙏\"", time: "Tomorrow, 9:03 AM" },
  ],
  voice: [
    { from: "user", voice: true, duration: "0:06", time: "7:12 AM" },
    { from: "ping", text: "Got it — reminding you every Tuesday and Thursday at 7am to hit the gym. First one's tomorrow 💪", time: "7:12 AM" },
  ],
  series: [
    { from: "user", text: "I have my LSATs in 3 weeks", time: "8:30 PM" },
    { from: "ping", text: "I'll check in 2 weeks out to start revision, again 5 days before, the night before, and morning-of. Sound good?", time: "8:31 PM" },
    { from: "user", text: "perfect", time: "8:31 PM" },
    { from: "ping", text: "⏰ 2 weeks to go — good time to start revising", time: "14 days later" },
  ],
  research: [
    { from: "user", text: "What's the latest on the OpenAI Apple lawsuit", time: "1:47 PM" },
    { from: "ping", text: "Sure! Give me a sec to look into that 🔍", time: "1:47 PM" },
    { from: "ping", text: "Apple just filed a trade secrets suit alleging 400+ former employees now work at OpenAI (reuters.com). Want the details?", time: "1:47 PM" },
  ],
};

// ---------------------------------------------------------------------------
// Render a thread into a chat-body element, animated bubble by bubble
// ---------------------------------------------------------------------------
function renderThread(el, messages, { loop = false } = {}) {
  let cancelled = false;
  el.dataset.cancelled = "false";

  async function play() {
    el.innerHTML = "";
    for (const msg of messages) {
      if (el.dataset.cancelled === "true") return;
      await sleep(msg.from === "ping" ? 650 : 450);
      appendBubble(el, msg);
      el.scrollTop = el.scrollHeight;
    }
    if (loop) {
      await sleep(2600);
      if (el.dataset.cancelled !== "true") play();
    }
  }
  play();

  return () => { el.dataset.cancelled = "true"; };
}

function appendBubble(el, msg) {
  const row = document.createElement("div");
  row.className = `bubble-row ${msg.from === "user" ? "out" : "in"}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${msg.from === "user" ? "out" : "in"}`;

  if (msg.voice) {
    bubble.innerHTML = `
      <div class="bubble-voice">
        <div class="play-btn">▶</div>
        <div class="waveform">${randomWaveform()}</div>
        <span style="font-size:0.68rem;opacity:0.75">${msg.duration}</span>
      </div>
      <div class="bubble-time">${msg.time}</div>
    `;
  } else {
    bubble.innerHTML = `${escapeHtml(msg.text)}<div class="bubble-time">${msg.time}</div>`;
  }

  row.appendChild(bubble);
  el.appendChild(row);
}

function randomWaveform() {
  let bars = "";
  for (let i = 0; i < 18; i++) {
    const h = 4 + Math.round(Math.random() * 14);
    bars += `<span style="height:${h}px"></span>`;
  }
  return bars;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Hero thread: play immediately, looping
// ---------------------------------------------------------------------------
const heroEl = document.getElementById("hero-chat");
if (heroEl) renderThread(heroEl, THREADS.hero, { loop: true });

// ---------------------------------------------------------------------------
// Feature threads: play once when scrolled into view
// ---------------------------------------------------------------------------
const featureThreads = document.querySelectorAll("[data-thread]");
const threadObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const el = entry.target;
      if (entry.isIntersecting && !el.dataset.played) {
        el.dataset.played = "true";
        const key = el.getAttribute("data-thread");
        if (THREADS[key]) renderThread(el, THREADS[key]);
      }
    });
  },
  { threshold: 0.4 }
);
featureThreads.forEach((el) => threadObserver.observe(el));

// ---------------------------------------------------------------------------
// Scroll reveal for sections
// ---------------------------------------------------------------------------
document.querySelectorAll(".feature-row, .step, .price-card, .faq-item").forEach((el) => {
  el.classList.add("reveal");
});
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.15 }
);
document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));

// ---------------------------------------------------------------------------
// Capture ad attribution (UTM + fbclid) so it can be attached to checkout later
// ---------------------------------------------------------------------------
(function captureAttribution() {
  const params = new URLSearchParams(window.location.search);
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
  const captured = {};
  let found = false;
  keys.forEach((k) => {
    const v = params.get(k);
    if (v) { captured[k] = v; found = true; }
  });
  if (found) {
    sessionStorage.setItem("ping_attribution", JSON.stringify(captured));
  }
})();

// ---------------------------------------------------------------------------
// Pricing buttons — placeholder until Stripe Checkout Session endpoint is wired
// ---------------------------------------------------------------------------
document.querySelectorAll("[data-plan]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const plan = btn.getAttribute("data-plan");
    // TODO: replace with a call to the Railway backend to create a Stripe
    // Checkout Session for `plan`, passing along sessionStorage.ping_attribution.
    console.log("Checkout requested for plan:", plan, sessionStorage.getItem("ping_attribution"));
    alert(`Checkout for the ${plan} plan isn't wired up yet — coming soon!`);
  });
});
