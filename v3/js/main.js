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

    builderAprPct: document.getElementById("builderAprPct"),
    teslaAprPct: document.getElementById("teslaAprPct"),
    loanYears: document.getElementById("loanYears"),
    horizonYears: document.getElementById("horizonYears"),
    discountRatePct: document.getElementById("discountRatePct"),
    utilityEscalationPct: document.getElementById("utilityEscalationPct"),
    solarDegradationPct: document.getElementById("solarDegradationPct"),
    batteryDegradationPct: document.getElementById("batteryDegradationPct"),

    enableWhf: document.getElementById("enableWhf"),
    whfMode: document.getElementById("whfMode"),
    whfFanWatts: document.getElementById("whfFanWatts"),
    whfDisplacedAcWatts: document.getElementById("whfDisplacedAcWatts"),
    whfSuccessRatePct: document.getElementById("whfSuccessRatePct"),
    whfStartHour: document.getElementById("whfStartHour"),
    whfStartMinute: document.getElementById("whfStartMinute"),
    whfEndHour: document.getElementById("whfEndHour"),
    whfEndMinute: document.getElementById("whfEndMinute"),
    whfMonthNodes: Array.from(document.querySelectorAll("[data-whf-month]")),

    enableHaShift: document.getElementById("enableHaShift"),
    haMode: document.getElementById("haMode"),
    summerSetpointF: document.getElementById("summerSetpointF"),
    winterSetpointF: document.getElementById("winterSetpointF"),
    maxPrecoolOffsetF: document.getElementById("maxPrecoolOffsetF"),
    maxPreheatOffsetF: document.getElementById("maxPreheatOffsetF"),
    maxPeakRelaxOffsetF: document.getElementById("maxPeakRelaxOffsetF"),
    hvacSensitivityKwhPerDegHour: document.getElementById("hvacSensitivityKwhPerDegHour"),
    hvacShiftSuccessRatePct: document.getElementById("hvacShiftSuccessRatePct"),
    preCoolStartHour: document.getElementById("preCoolStartHour"),
    preCoolEndHour: document.getElementById("preCoolEndHour"),
    maxShiftHoursPerDay: document.getElementById("maxShiftHoursPerDay"),
    maxShiftKwhPerDay: document.getElementById("maxShiftKwhPerDay"),

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

  function clamp(n, low, high) {
    return Math.min(high, Math.max(low, n));
  }

  function collectWhfActiveMonths() {
    return dom.whfMonthNodes
      .filter((node) => node.checked)
      .map((node) => Number(node.dataset.whfMonth))
      .filter((month) => Number.isInteger(month) && month >= 0 && month <= 11);
  }

  function collectInputs() {
    const whfEnabled = !!dom.enableWhf.checked;
    const haEnabled = !!dom.enableHaShift.checked;

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
        builderAprPct: valueOf(dom.builderAprPct, 6),
        teslaAprPct: valueOf(dom.teslaAprPct, 7.5),
        loanYears: Math.max(1, Math.floor(valueOf(dom.loanYears, 15)))
      },
      analysis: {
        horizonYears: Math.max(5, Math.floor(valueOf(dom.horizonYears, 15))),
        discountRatePct: valueOf(dom.discountRatePct, 6),
        utilityEscalationPct: valueOf(dom.utilityEscalationPct, 3),
        solarDegradationPct: valueOf(dom.solarDegradationPct, 0.5),
        batteryDegradationPct: valueOf(dom.batteryDegradationPct, 2)
      },
      homeFlex: {
        whf: {
          enabled: whfEnabled,
          mode: dom.whfMode.value === "manual" ? "manual" : "auto",
          fanWatts: valueOf(dom.whfFanWatts, 200),
          displacedAcWatts: valueOf(dom.whfDisplacedAcWatts, 3500),
          successRatePct: valueOf(dom.whfSuccessRatePct, 85),
          startHour: Math.floor(valueOf(dom.whfStartHour, 20)),
          startMinute: Math.floor(valueOf(dom.whfStartMinute, 30)),
          endHour: Math.floor(valueOf(dom.whfEndHour, 6)),
          endMinute: Math.floor(valueOf(dom.whfEndMinute, 0)),
          activeMonths: collectWhfActiveMonths()
        },
        ha: {
          enabled: haEnabled,
          mode: dom.haMode.value === "manual" ? "manual" : "auto",
          summerSetpointF: valueOf(dom.summerSetpointF, 74),
          winterSetpointF: valueOf(dom.winterSetpointF, 68),
          maxPrecoolOffsetF: valueOf(dom.maxPrecoolOffsetF, 3),
          maxPreheatOffsetF: valueOf(dom.maxPreheatOffsetF, 2),
          maxPeakRelaxOffsetF: valueOf(dom.maxPeakRelaxOffsetF, 2),
          hvacSensitivityKwhPerDegHour: valueOf(dom.hvacSensitivityKwhPerDegHour, 0.6),
          successRatePct: valueOf(dom.hvacShiftSuccessRatePct, 70),
          preCoolStartHour: Math.floor(valueOf(dom.preCoolStartHour, 12)),
          preCoolEndHour: Math.floor(valueOf(dom.preCoolEndHour, 16)),
          maxShiftHoursPerDay: Math.floor(valueOf(dom.maxShiftHoursPerDay, 4)),
          maxShiftKwhPerDay: valueOf(dom.maxShiftKwhPerDay, 6)
        }
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

    if (inputs.financing.builderAprPct < 0 || inputs.financing.teslaAprPct < 0) {
      errors.push("Builder/Tesla APR cannot be negative.");
    }

    const whf = inputs.homeFlex.whf;
    if (whf.enabled && whf.mode === "manual") {
      const startMinute = (clamp(whf.startHour, 0, 23) * 60) + clamp(whf.startMinute, 0, 59);
      const endMinute = (clamp(whf.endHour, 0, 23) * 60) + clamp(whf.endMinute, 0, 59);
      if (startMinute === endMinute) {
        errors.push("WHF manual start and end times must define a non-zero window.");
      }
      if (!whf.activeMonths.length) {
        errors.push("WHF manual mode requires at least one active month.");
      }
    }

    const ha = inputs.homeFlex.ha;
    if (ha.enabled && ha.mode === "manual") {
      if (clamp(ha.preCoolStartHour, 0, 23) === clamp(ha.preCoolEndHour, 0, 23)) {
        errors.push("HVAC manual pre-window must define a non-zero hour window.");
      }
    }

    if (ha.enabled && ha.maxShiftHoursPerDay <= 0) {
      errors.push("HVAC max shift hours/day must be at least 1 when enabled.");
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

  function setEnabled(input, enabled) {
    if (!input) return;
    input.disabled = !enabled;
  }

  function updateHomeFlexFieldStates() {
    const whfEnabled = !!dom.enableWhf.checked;
    const whfManual = whfEnabled && dom.whfMode.value === "manual";
    setEnabled(dom.whfMode, whfEnabled);
    setEnabled(dom.whfFanWatts, whfEnabled);
    setEnabled(dom.whfDisplacedAcWatts, whfEnabled);
    setEnabled(dom.whfSuccessRatePct, whfManual);
    setEnabled(dom.whfStartHour, whfManual);
    setEnabled(dom.whfStartMinute, whfManual);
    setEnabled(dom.whfEndHour, whfManual);
    setEnabled(dom.whfEndMinute, whfManual);
    dom.whfMonthNodes.forEach((node) => {
      node.disabled = !whfManual;
    });

    const haEnabled = !!dom.enableHaShift.checked;
    const haManual = haEnabled && dom.haMode.value === "manual";
    setEnabled(dom.haMode, haEnabled);
    setEnabled(dom.summerSetpointF, haEnabled);
    setEnabled(dom.winterSetpointF, haEnabled);
    setEnabled(dom.maxPrecoolOffsetF, haEnabled);
    setEnabled(dom.maxPreheatOffsetF, haEnabled);
    setEnabled(dom.maxPeakRelaxOffsetF, haEnabled);
    setEnabled(dom.hvacSensitivityKwhPerDegHour, haEnabled);
    setEnabled(dom.maxShiftHoursPerDay, haEnabled);
    setEnabled(dom.maxShiftKwhPerDay, haEnabled);
    setEnabled(dom.hvacShiftSuccessRatePct, haManual);
    setEnabled(dom.preCoolStartHour, haManual);
    setEnabled(dom.preCoolEndHour, haManual);
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
    dom.builderAprPct,
    dom.teslaAprPct,
    dom.loanYears,
    dom.horizonYears,
    dom.discountRatePct,
    dom.utilityEscalationPct,
    dom.solarDegradationPct,
    dom.batteryDegradationPct,
    dom.enableWhf,
    dom.whfMode,
    dom.whfFanWatts,
    dom.whfDisplacedAcWatts,
    dom.whfSuccessRatePct,
    dom.whfStartHour,
    dom.whfStartMinute,
    dom.whfEndHour,
    dom.whfEndMinute,
    ...dom.whfMonthNodes,
    dom.enableHaShift,
    dom.haMode,
    dom.summerSetpointF,
    dom.winterSetpointF,
    dom.maxPrecoolOffsetF,
    dom.maxPreheatOffsetF,
    dom.maxPeakRelaxOffsetF,
    dom.hvacSensitivityKwhPerDegHour,
    dom.hvacShiftSuccessRatePct,
    dom.preCoolStartHour,
    dom.preCoolEndHour,
    dom.maxShiftHoursPerDay,
    dom.maxShiftKwhPerDay
  ];

  let renderTimer = null;
  liveInputs.forEach(function bindLive(input) {
    if (!input) return;
    input.addEventListener("input", function onInput() {
      updateHomeFlexFieldStates();
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(function rerender() {
        renderTimer = null;
        void runPlanner();
      }, 180);
    });
    input.addEventListener("change", function onChange() {
      updateHomeFlexFieldStates();
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(function rerenderFromChange() {
        renderTimer = null;
        void runPlanner();
      }, 180);
    });
  });

  updateHomeFlexFieldStates();
  void runPlanner();
})(window);
