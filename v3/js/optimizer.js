(function initOptimizerModule(global) {
  "use strict";

  const namespace = global.SolarPlanner = global.SolarPlanner || {};
  const model = namespace.model;
  const engine = namespace.engineV261;

  if (!model || !engine) {
    throw new Error("engine-v261.js and model.js must load before optimizer.js");
  }

  const TESLA_MAX_POWERWALLS = 2;
  const EPSILON = 1e-6;
  const REQUIRED_ANNUAL_FIELDS = [
    "annualUtilitySavings",
    "annualVppRevenue",
    "annualNetEnergyEconomics",
    "annualSolarGenerationKwh",
    "annualUtilityBillAfter"
  ];

  function getFiniteAnnualMetrics(annual) {
    if (!annual || typeof annual !== "object") {
      return { ok: false, error: "Annual simulation output is missing." };
    }

    for (let i = 0; i < REQUIRED_ANNUAL_FIELDS.length; i += 1) {
      const key = REQUIRED_ANNUAL_FIELDS[i];
      if (!Number.isFinite(annual[key])) {
        return { ok: false, error: "Annual simulation output is non-finite for " + key + "." };
      }
    }

    const annualUtilitySavings = annual.annualUtilitySavings;
    const annualVppRevenue = annual.annualVppRevenue;

    return {
      ok: true,
      metrics: {
        annualUtilitySavings,
        annualVppRevenue,
        annualNetBenefit: annualUtilitySavings + annualVppRevenue,
        annualNetEnergyEconomics: annual.annualNetEnergyEconomics,
        annualSolarGenerationKwh: annual.annualSolarGenerationKwh,
        annualUtilityBillAfter: annual.annualUtilityBillAfter
      }
    };
  }

  function compareUpgradeObjective(a, b) {
    if (Math.abs(a.incrementalLeveredNpv - b.incrementalLeveredNpv) > 1e-9) {
      return b.incrementalLeveredNpv - a.incrementalLeveredNpv;
    }
    if (Math.abs(a.incrementalMonthlyNetOutflow - b.incrementalMonthlyNetOutflow) > 1e-9) {
      return a.incrementalMonthlyNetOutflow - b.incrementalMonthlyNetOutflow;
    }
    if (Math.abs(a.incrementalCapex - b.incrementalCapex) > 1e-9) {
      return a.incrementalCapex - b.incrementalCapex;
    }
    if (a.finalPowerwalls !== b.finalPowerwalls) {
      return a.finalPowerwalls - b.finalPowerwalls;
    }
    return a.finalSolarKw - b.finalSolarKw;
  }

  function buildBaselineScenario(runtimeContext) {
    const base = runtimeContext.baseline;
    const annual = engine.calculateAnnualEnergyAndBills(
      runtimeContext.simulationInputs,
      base.baseSolarKw,
      base.basePowerwalls
    );
    const annualCheck = getFiniteAnnualMetrics(annual);
    if (!annualCheck.ok) {
      return {
        ...base,
        annual,
        error: "Baseline simulation failed: " + annualCheck.error
      };
    }

    const annualMetrics = annualCheck.metrics;
    const monthlyLoanPayment = model.mortgagePayment(
      base.baseQuote,
      runtimeContext.financing.builderAprPct,
      runtimeContext.financing.loanYears
    );

    return {
      ...base,
      annual,
      error: null,
      annualNetBenefit: annualMetrics.annualNetBenefit,
      monthlyLoanPayment,
      monthlyNetEnergyOutflow: annualMetrics.annualNetEnergyEconomics / 12,
      monthlyNetOutflowWithLoan: (annualMetrics.annualNetEnergyEconomics / 12) + monthlyLoanPayment
    };
  }

  function buildUpgradeScenario(runtimeContext, baselineScenario, finalSolarKwRaw, finalPowerwallsRaw) {
    const costs = model.computeTeslaUpgradeCosts(runtimeContext, finalSolarKwRaw, finalPowerwallsRaw);
    const isNoUpgrade = costs.addedSolarKw <= EPSILON && costs.finalPowerwalls === baselineScenario.basePowerwalls;

    if (isNoUpgrade) {
      return {
        finalSolarKw: baselineScenario.baseSolarKw,
        finalPowerwalls: baselineScenario.basePowerwalls,
        isNoUpgrade: true,
        error: null,
        annual: baselineScenario.annual,
        annualNetBenefit: baselineScenario.annualNetBenefit,
        annualOperatingBenefit: 0,
        addedSolarKw: 0,
        solarRatePerKw: costs.solarRatePerKw,
        solarUpgradeCost: 0,
        batteryUpgradeCost: 0,
        incrementalCapex: 0,
        incrementalAnnualBenefit: 0,
        incrementalAnnualOperatingBenefit: 0,
        incrementalMonthlyEnergyDelta: 0,
        incrementalLoanPayment: 0,
        monthlyFinancingCostDelta: 0,
        incrementalMonthlyNetOutflow: 0,
        incrementalNpv: 0,
        incrementalPaybackYears: Number.POSITIVE_INFINITY,
        incrementalIrr: null,
        incrementalCumulative: 0,
        incrementalLeveredNpv: 0,
        incrementalLeveredPaybackYears: Number.POSITIVE_INFINITY,
        incrementalLeveredIrr: null,
        incrementalLeveredCumulative: 0,
        totalSystemCostProxy: baselineScenario.baseQuote,
        builderBaseSolarKwh: baselineScenario.annual.annualSolarGenerationKwh,
        teslaAddedSolarKwh: 0,
        annualSolarKwh: baselineScenario.annual.annualSolarGenerationKwh,
        annualUtilityAfter: baselineScenario.annual.annualUtilityBillAfter,
        annualNetEnergyEconomics: baselineScenario.annual.annualNetEnergyEconomics,
        annualVppRevenue: baselineScenario.annual.annualVppRevenue
      };
    }

    const annual = engine.calculateAnnualEnergyAndBills(
      runtimeContext.simulationInputs,
      costs.finalSolarKw,
      costs.finalPowerwalls
    );
    const annualCheck = getFiniteAnnualMetrics(annual);
    if (!annualCheck.ok) {
      return {
        finalSolarKw: costs.finalSolarKw,
        finalPowerwalls: costs.finalPowerwalls,
        error: "Scenario simulation failed: " + annualCheck.error
      };
    }
    const annualMetrics = annualCheck.metrics;

    const incrementalAnnualOperatingBenefit = annualMetrics.annualNetBenefit - baselineScenario.annualNetBenefit;
    const incrementalMonthlyEnergyDelta =
      (annualMetrics.annualNetEnergyEconomics - baselineScenario.annual.annualNetEnergyEconomics) / 12;

    const incrementalLoanPayment = model.mortgagePayment(
      costs.incrementalCapex,
      runtimeContext.financing.teslaAprPct,
      runtimeContext.financing.loanYears
    );

    const monthlyFinancingCostDelta = incrementalLoanPayment;
    const incrementalMonthlyNetOutflow = incrementalMonthlyEnergyDelta + monthlyFinancingCostDelta;

    const unleveredReturns = model.projectIncrementalReturns(
      runtimeContext,
      costs.incrementalCapex,
      incrementalAnnualOperatingBenefit,
      costs.finalPowerwalls
    );
    const leveredReturns = model.projectIncrementalLeveredReturns(
      runtimeContext,
      costs.incrementalCapex,
      incrementalAnnualOperatingBenefit,
      costs.finalPowerwalls
    );

    const teslaAddedSolarKwh = Math.max(0, annualMetrics.annualSolarGenerationKwh - baselineScenario.annual.annualSolarGenerationKwh);

    return {
      finalSolarKw: costs.finalSolarKw,
      finalPowerwalls: costs.finalPowerwalls,
      isNoUpgrade: false,
      error: null,
      annual,
      annualNetBenefit: annualMetrics.annualNetBenefit,
      annualOperatingBenefit: incrementalAnnualOperatingBenefit,
      addedSolarKw: costs.addedSolarKw,
      solarRatePerKw: costs.solarRatePerKw,
      solarUpgradeCost: costs.solarUpgradeCost,
      batteryUpgradeCost: costs.batteryUpgradeCost,
      incrementalCapex: costs.incrementalCapex,
      incrementalAnnualBenefit: incrementalAnnualOperatingBenefit,
      incrementalAnnualOperatingBenefit,
      incrementalMonthlyEnergyDelta,
      incrementalLoanPayment,
      monthlyFinancingCostDelta,
      incrementalMonthlyNetOutflow,
      incrementalNpv: unleveredReturns.npv,
      incrementalPaybackYears: unleveredReturns.paybackYears,
      incrementalIrr: unleveredReturns.irr,
      incrementalCumulative: unleveredReturns.cumulative,
      incrementalLeveredNpv: leveredReturns.npv,
      incrementalLeveredPaybackYears: leveredReturns.paybackYears,
      incrementalLeveredIrr: leveredReturns.irr,
      incrementalLeveredCumulative: leveredReturns.cumulative,
      totalSystemCostProxy: baselineScenario.baseQuote + costs.incrementalCapex,
      builderBaseSolarKwh: baselineScenario.annual.annualSolarGenerationKwh,
      teslaAddedSolarKwh,
      annualSolarKwh: annualMetrics.annualSolarGenerationKwh,
      annualUtilityAfter: annualMetrics.annualUtilityBillAfter,
      annualNetEnergyEconomics: annualMetrics.annualNetEnergyEconomics,
      annualVppRevenue: annualMetrics.annualVppRevenue
    };
  }

  function optimizeTeslaUpgradesFromBase(runtimeContext, options) {
    const opts = options || {};
    const baseline = buildBaselineScenario(runtimeContext);

    if (baseline.error) {
      return {
        error: baseline.error,
        objective: "max_incremental_levered_npv",
        baseline,
        solarCandidates: [],
        powerwallCandidates: [],
        results: [],
        best: null,
        noUpgradeRecommended: true,
        invalidScenarioCount: 0
      };
    }

    const sizing = runtimeContext.rawInputs.sizing;
    const minSolar = Math.max(baseline.baseSolarKw, model.asFinite(sizing.solarMinKw, baseline.baseSolarKw));
    const maxSolar = model.asFinite(sizing.solarMaxKw, baseline.baseSolarKw + 10);
    const stepSolar = model.asFinite(sizing.solarStepKw, 0.1);

    const solarCandidates = engine.buildSolarCandidates(minSolar, maxSolar, stepSolar);
    if (!solarCandidates.length) {
      return {
        error: "Invalid solar candidate range. Ensure max >= min and step > 0.",
        baseline,
        solarCandidates: [],
        powerwallCandidates: [],
        results: [],
        best: null,
        noUpgradeRecommended: false,
        invalidScenarioCount: 0
      };
    }

    const fixedPowerwall = Number.isFinite(opts.fixedPowerwall)
      ? model.clamp(Math.floor(opts.fixedPowerwall), baseline.basePowerwalls, TESLA_MAX_POWERWALLS)
      : null;

    const powerwallCandidates = fixedPowerwall === null
      ? [0, 1, 2]
      : [fixedPowerwall];

    let invalidScenarioCount = 0;
    const byKey = new Map();
    powerwallCandidates.forEach((pw) => {
      solarCandidates.forEach((solarKw) => {
        const scenario = buildUpgradeScenario(runtimeContext, baseline, solarKw, pw);
        if (scenario.error) {
          invalidScenarioCount += 1;
          return;
        }
        byKey.set(scenario.finalSolarKw.toFixed(6) + "|" + scenario.finalPowerwalls, scenario);
      });
    });

    // Always include explicit no-upgrade candidate.
    const noUpgrade = buildUpgradeScenario(runtimeContext, baseline, baseline.baseSolarKw, baseline.basePowerwalls);
    if (!noUpgrade.error) {
      byKey.set(noUpgrade.finalSolarKw.toFixed(6) + "|" + noUpgrade.finalPowerwalls, noUpgrade);
    } else {
      invalidScenarioCount += 1;
    }

    const results = Array.from(byKey.values()).sort(compareUpgradeObjective);
    if (!results.length) {
      return {
        error: "No valid upgrade scenarios were produced. Check climate/rate inputs.",
        objective: "max_incremental_levered_npv",
        baseline,
        solarCandidates,
        powerwallCandidates,
        results: [],
        best: null,
        noUpgradeRecommended: true,
        invalidScenarioCount
      };
    }

    const first = results[0] || null;
    const noUpgradeRow = results.find((row) => row.isNoUpgrade) || null;
    const bestUpgradeRow = results.find((row) => !row.isNoUpgrade) || null;
    const noUpgradeRecommended = !bestUpgradeRow || (
      bestUpgradeRow.incrementalAnnualOperatingBenefit <= EPSILON
      && bestUpgradeRow.incrementalNpv <= EPSILON
    );
    const best = noUpgradeRecommended
      ? (noUpgradeRow || first)
      : (bestUpgradeRow || first);

    return {
      error: null,
      objective: "max_incremental_levered_npv",
      baseline,
      solarCandidates,
      powerwallCandidates,
      results,
      best,
      noUpgradeRecommended,
      invalidScenarioCount
    };
  }

  function buildUpgradeSummary(runtimeContext) {
    const optimization = optimizeTeslaUpgradesFromBase(runtimeContext);
    return {
      error: optimization.error,
      baseline: optimization.baseline,
      bestUpgrade: optimization.best,
      noUpgradeRecommended: optimization.noUpgradeRecommended,
      optimization
    };
  }

  function buildExpansionExplanation(runtimeContext, optimization) {
    const opt = optimization || optimizeTeslaUpgradesFromBase(runtimeContext);
    if (opt.error || !opt.best) {
      return {
        error: opt.error || "No optimization result available.",
        steps: [],
        recommendedPowerwalls: 0,
        startPowerwalls: 0
      };
    }

    const bestByPw = new Map();
    for (let pw = 0; pw <= TESLA_MAX_POWERWALLS; pw += 1) {
      const fixed = optimizeTeslaUpgradesFromBase(runtimeContext, { fixedPowerwall: pw });
      if (fixed.error || !fixed.best) {
        return {
          error: fixed.error || ("Unable to evaluate fixed " + pw + " PW path."),
          steps: [],
          recommendedPowerwalls: opt.best.finalPowerwalls,
          startPowerwalls: 0
        };
      }
      bestByPw.set(pw, fixed.best);
    }

    const steps = [];
    for (let toPw = 1; toPw <= TESLA_MAX_POWERWALLS; toPw += 1) {
      const fromPw = toPw - 1;
      const prev = bestByPw.get(fromPw);
      const next = bestByPw.get(toPw);
      if (!prev || !next) continue;

      steps.push({
        fromPowerwalls: fromPw,
        toPowerwalls: toPw,
        bestSolarKw: next.finalSolarKw,
        annualSolarKwh: next.annualSolarKwh,
        teslaAddedSolarKwh: next.teslaAddedSolarKwh,
        deltaAnnualBenefit: next.incrementalAnnualOperatingBenefit - prev.incrementalAnnualOperatingBenefit,
        deltaNpv: next.incrementalLeveredNpv - prev.incrementalLeveredNpv,
        deltaMonthlyOutflow: next.incrementalMonthlyNetOutflow - prev.incrementalMonthlyNetOutflow,
        onRecommendedPath: toPw <= opt.best.finalPowerwalls
      });
    }

    return {
      error: null,
      startPowerwalls: 0,
      recommendedPowerwalls: opt.best.finalPowerwalls,
      steps,
      noUpgradeRecommended: !!opt.noUpgradeRecommended
    };
  }

  namespace.optimizer = {
    TESLA_MAX_POWERWALLS,
    compareUpgradeObjective,
    buildBaselineScenario,
    buildUpgradeScenario,
    optimizeTeslaUpgradesFromBase,
    buildUpgradeSummary,
    buildExpansionExplanation
  };
})(window);
