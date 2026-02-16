(function initMain(global) {
  "use strict";

  const namespace = global.SolarPlanner = global.SolarPlanner || {};
  const engine = namespace.engineV261;
  const model = namespace.model;
  const optimizer = namespace.optimizer;
  const ui = namespace.ui;

  if (!engine || !model || !optimizer || !ui) {
    throw new Error("engine-v261.js, model.js, optimizer.js, and ui.js must load before main.js");
  }

  const dom = {
    form: document.getElementById("plannerForm"),
    formError: document.getElementById("formError"),

    builderBasePresetKw: document.getElementById("builderBasePresetKw"),
    solarMinKw: document.getElementById("solarMinKw"),
    solarMaxKw: document.getElementById("solarMaxKw"),
    solarStepKw: document.getElementById("solarStepKw"),

    annualLoadKwh: document.getElementById("annualLoadKwh"),
    zipCode: document.getElementById("zipCode"),
    nrelApiKey: document.getElementById("nrelApiKey"),

    importOffPeak: document.getElementById("importOffPeak"),
    importPeak: document.getElementById("importPeak"),
    exportRate: document.getElementById("exportRate"),
    nbcRate: document.getElementById("nbcRate"),
    fixedMonthlyCharge: document.getElementById("fixedMonthlyCharge"),

    builderBaseQuote395: document.getElementById("builderBaseQuote395"),
    builderBaseQuote553: document.getElementById("builderBaseQuote553"),

    teslaSolarBelow10: document.getElementById("teslaSolarBelow10"),
    teslaSolarAtLeast10: document.getElementById("teslaSolarAtLeast10"),
    teslaBattery1: document.getElementById("teslaBattery1"),
    teslaBattery2: document.getElementById("teslaBattery2"),

    vppEnabled: document.getElementById("vppEnabled"),

    aprPct: document.getElementById("aprPct"),
    loanYears: document.getElementById("loanYears"),
    horizonYears: document.getElementById("horizonYears"),
    discountRatePct: document.getElementById("discountRatePct"),
    utilityEscalationPct: document.getElementById("utilityEscalationPct"),
    solarDegradationPct: document.getElementById("solarDegradationPct"),
    batteryDegradationPct: document.getElementById("batteryDegradationPct"),

    climateStatus: document.getElementById("climateStatus"),

    noUpgradeBanner: document.getElementById("noUpgradeBanner"),

    kpiBaseSystem: document.getElementById("kpiBaseSystem"),
    kpiBaseDetail: document.getElementById("kpiBaseDetail"),
    kpiUpgradeSystem: document.getElementById("kpiUpgradeSystem"),
    kpiUpgradeDetail: document.getElementById("kpiUpgradeDetail"),
    kpiIncrementalNpv: document.getElementById("kpiIncrementalNpv"),
    kpiIncrementalNpvDetail: document.getElementById("kpiIncrementalNpvDetail"),
    kpiExpansion: document.getElementById("kpiExpansion"),
    kpiExpansionDetail: document.getElementById("kpiExpansionDetail"),

    scenarioLabel: document.getElementById("scenarioLabel"),
    scenarioMetrics: document.getElementById("scenarioMetrics"),

    expansionSummary: document.getElementById("expansionSummary"),
    expansionTableBody: document.querySelector("#expansionTable tbody"),

    topScenarioHint: document.getElementById("topScenarioHint"),
    topScenarioTableBody: document.querySelector("#topScenarioTable tbody")
  };

  let renderToken = 0;

  function valueOf(input, fallback) {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function collectInputs() {
    return {
      sizing: {
        builderBasePresetKw: dom.builderBasePresetKw.value === "5.53" ? "5.53" : "3.95",
        solarMinKw: valueOf(dom.solarMinKw, 3.95),
        solarMaxKw: valueOf(dom.solarMaxKw, 22),
        solarStepKw: valueOf(dom.solarStepKw, 0.1)
      },
      baselineQuotes: {
        quote395: valueOf(dom.builderBaseQuote395, 13710),
        quote553: valueOf(dom.builderBaseQuote553, 18110)
      },
      home: {
        annualLoadKwh: valueOf(dom.annualLoadKwh, 24000)
      },
      climate: {
        zipCode: String(dom.zipCode.value || "").trim(),
        nrelApiKey: String(dom.nrelApiKey.value || "").trim()
      },
      rates: {
        importOffPeak: valueOf(dom.importOffPeak, 0.36),
        importPeak: valueOf(dom.importPeak, 0.58),
        exportRate: valueOf(dom.exportRate, 0.04),
        nbcRate: valueOf(dom.nbcRate, 0.03),
        fixedMonthlyCharge: valueOf(dom.fixedMonthlyCharge, 24.15)
      },
      pricing: {
        teslaSolarRates: {
          below10: valueOf(dom.teslaSolarBelow10, 2760),
          atLeast10: valueOf(dom.teslaSolarAtLeast10, 2660)
        },
        teslaBatteryCosts: {
          0: 0,
          1: valueOf(dom.teslaBattery1, 3900),
          2: valueOf(dom.teslaBattery2, 9700)
        }
      },
      battery: {
        vppEnabled: !!dom.vppEnabled.checked
      },
      financing: {
        aprPct: valueOf(dom.aprPct, 6),
        loanYears: Math.max(1, Math.floor(valueOf(dom.loanYears, 15)))
      },
      analysis: {
        horizonYears: Math.max(5, Math.floor(valueOf(dom.horizonYears, 15))),
        discountRatePct: valueOf(dom.discountRatePct, 6),
        utilityEscalationPct: valueOf(dom.utilityEscalationPct, 3),
        solarDegradationPct: valueOf(dom.solarDegradationPct, 0.5),
        batteryDegradationPct: valueOf(dom.batteryDegradationPct, 2)
      }
    };
  }

  function validate(inputs) {
    const errors = [];
    const baseKw = inputs.sizing.builderBasePresetKw === "5.53" ? 5.53 : 3.95;

    if (inputs.sizing.solarStepKw <= 0) {
      errors.push("Solar step must be greater than 0.");
    }
    if (inputs.sizing.solarMaxKw < inputs.sizing.solarMinKw) {
      errors.push("Solar max must be greater than or equal to solar min.");
    }
    if (inputs.sizing.solarMaxKw < baseKw) {
      errors.push("Solar max must be at least the selected Builder base kW (" + baseKw + ").");
    }
    if (inputs.home.annualLoadKwh <= 0) {
      errors.push("Annual load must be greater than 0.");
    }
    if (inputs.baselineQuotes.quote395 < 0 || inputs.baselineQuotes.quote553 < 0) {
      errors.push("Builder base quote values cannot be negative.");
    }

    return errors;
  }

  function setClimateStatus(snapshot) {
    if (!snapshot) {
      dom.climateStatus.textContent = "Climate: pending";
      return;
    }
    if (snapshot.status === "verified_live" || snapshot.status === "verified_cache") {
      dom.climateStatus.textContent =
        "Climate: " + snapshot.locationLabel +
        " | source=" + (snapshot.status === "verified_live" ? "NREL live" : "cache") +
        " | key=" + (snapshot.keyMode === "user_key" ? "user" : "demo");
    } else {
      dom.climateStatus.textContent =
        "Climate fallback: synthetic profile (" + (snapshot.fallbackReason || "missing_data") + ")";
    }
  }

  async function runPlanner() {
    const token = ++renderToken;
    const inputs = collectInputs();
    const errors = validate(inputs);

    if (errors.length) {
      const message = errors.join(" ");
      dom.formError.textContent = message;
      ui.renderAll(dom, {
        summary: { error: message, bestUpgrade: null },
        optimization: { error: message, results: [] },
        expansion: { error: message, steps: [] },
        climateSnapshot: null
      });
      return;
    }

    dom.formError.textContent = "";
    dom.climateStatus.textContent = "Climate: loading...";

    const climateContext = engine.buildClimateContext(inputs.climate.zipCode, inputs.climate.nrelApiKey);
    const climateSnapshot = await engine.getClimateProfile(climateContext);
    if (token !== renderToken) return;

    setClimateStatus(climateSnapshot);

    const runtimeContext = model.buildRuntimeContext(inputs, climateSnapshot);
    const summary = optimizer.buildUpgradeSummary(runtimeContext);
    const optimization = summary.optimization;
    const expansion = optimizer.buildExpansionExplanation(runtimeContext, optimization);

    ui.renderAll(dom, {
      summary,
      optimization,
      expansion,
      climateSnapshot
    });
  }

  dom.form.addEventListener("submit", function handleSubmit(event) {
    event.preventDefault();
    void runPlanner();
  });

  const liveInputs = [
    dom.builderBasePresetKw,
    dom.solarMinKw,
    dom.solarMaxKw,
    dom.solarStepKw,
    dom.annualLoadKwh,
    dom.zipCode,
    dom.nrelApiKey,
    dom.importOffPeak,
    dom.importPeak,
    dom.exportRate,
    dom.nbcRate,
    dom.fixedMonthlyCharge,
    dom.builderBaseQuote395,
    dom.builderBaseQuote553,
    dom.teslaSolarBelow10,
    dom.teslaSolarAtLeast10,
    dom.teslaBattery1,
    dom.teslaBattery2,
    dom.vppEnabled,
    dom.aprPct,
    dom.loanYears,
    dom.horizonYears,
    dom.discountRatePct,
    dom.utilityEscalationPct,
    dom.solarDegradationPct,
    dom.batteryDegradationPct
  ];

  let renderTimer = null;
  liveInputs.forEach(function bindLive(input) {
    input.addEventListener("input", function onInput() {
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(function rerender() {
        renderTimer = null;
        void runPlanner();
      }, 180);
    });
  });

  void runPlanner();
})(window);
