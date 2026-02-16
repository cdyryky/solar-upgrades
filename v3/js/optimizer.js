(function initOptimizerModule(global) {
  "use strict";

  const namespace = global.SolarPlanner = global.SolarPlanner || {};
  const model = namespace.model;
  const engine = namespace.engineV261;

  if (!model || !engine) {
    throw new Error("engine-v261.js and model.js must load before optimizer.js");
  }

  const TESLA_MAX_POWERWALLS = 2;

  function annualNetBenefitFromAnnual(annual) {
    return (annual.annualUtilitySavings || 0) + (annual.annualVppRevenue || 0);
  }

  function compareUpgradeObjective(a, b) {
    if (Math.abs(a.incrementalNpv - b.incrementalNpv) > 1e-9) {
      return b.incrementalNpv - a.incrementalNpv;
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

    const annualNetBenefit = annualNetBenefitFromAnnual(annual);
    const monthlyLoanPayment = model.mortgagePayment(
      base.baseQuote,
      runtimeContext.financing.aprPct,
      runtimeContext.financing.loanYears
    );

    return {
      ...base,
      annual,
      annualNetBenefit,
      monthlyLoanPayment,
      monthlyNetEnergyOutflow: (annual.annualNetEnergyEconomics || 0) / 12,
      monthlyNetOutflowWithLoan: ((annual.annualNetEnergyEconomics || 0) / 12) + monthlyLoanPayment
    };
  }

  function buildUpgradeScenario(runtimeContext, baselineScenario, finalSolarKwRaw, finalPowerwallsRaw) {
    const costs = model.computeTeslaUpgradeCosts(runtimeContext, finalSolarKwRaw, finalPowerwallsRaw);

    const annual = engine.calculateAnnualEnergyAndBills(
      runtimeContext.simulationInputs,
      costs.finalSolarKw,
      costs.finalPowerwalls
    );
    const annualNetBenefit = annualNetBenefitFromAnnual(annual);

    const incrementalAnnualBenefit = annualNetBenefit - baselineScenario.annualNetBenefit;
    const incrementalMonthlyEnergyDelta =
      ((annual.annualNetEnergyEconomics || 0) - (baselineScenario.annual.annualNetEnergyEconomics || 0)) / 12;

    const incrementalLoanPayment = model.mortgagePayment(
      costs.incrementalCapex,
      runtimeContext.financing.aprPct,
      runtimeContext.financing.loanYears
    );

    const incrementalMonthlyNetOutflow = incrementalMonthlyEnergyDelta + incrementalLoanPayment;

    const returns = model.projectIncrementalReturns(
      runtimeContext,
      costs.incrementalCapex,
      incrementalAnnualBenefit,
      costs.finalPowerwalls
    );

    const teslaAddedSolarKwh = Math.max(0, (annual.annualSolarGenerationKwh || 0) - (baselineScenario.annual.annualSolarGenerationKwh || 0));

    return {
      finalSolarKw: costs.finalSolarKw,
      finalPowerwalls: costs.finalPowerwalls,
      isNoUpgrade: costs.addedSolarKw <= 1e-9 && costs.finalPowerwalls === baselineScenario.basePowerwalls,
      annual,
      annualNetBenefit,
      addedSolarKw: costs.addedSolarKw,
      solarRatePerKw: costs.solarRatePerKw,
      solarUpgradeCost: costs.solarUpgradeCost,
      batteryUpgradeCost: costs.batteryUpgradeCost,
      incrementalCapex: costs.incrementalCapex,
      incrementalAnnualBenefit,
      incrementalMonthlyEnergyDelta,
      incrementalLoanPayment,
      incrementalMonthlyNetOutflow,
      incrementalNpv: returns.npv,
      incrementalPaybackYears: returns.paybackYears,
      incrementalIrr: returns.irr,
      incrementalCumulative: returns.cumulative,
      totalSystemCostProxy: baselineScenario.baseQuote + costs.incrementalCapex,
      builderBaseSolarKwh: baselineScenario.annual.annualSolarGenerationKwh || 0,
      teslaAddedSolarKwh,
      annualSolarKwh: annual.annualSolarGenerationKwh || 0,
      annualUtilityAfter: annual.annualUtilityBillAfter || 0,
      annualNetEnergyEconomics: annual.annualNetEnergyEconomics || 0,
      annualVppRevenue: annual.annualVppRevenue || 0
    };
  }

  function optimizeTeslaUpgradesFromBase(runtimeContext, options) {
    const opts = options || {};
    const baseline = buildBaselineScenario(runtimeContext);

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
        noUpgradeRecommended: false
      };
    }

    const fixedPowerwall = Number.isFinite(opts.fixedPowerwall)
      ? model.clamp(Math.floor(opts.fixedPowerwall), baseline.basePowerwalls, TESLA_MAX_POWERWALLS)
      : null;

    const powerwallCandidates = fixedPowerwall === null
      ? [0, 1, 2]
      : [fixedPowerwall];

    const byKey = new Map();
    powerwallCandidates.forEach((pw) => {
      solarCandidates.forEach((solarKw) => {
        const scenario = buildUpgradeScenario(runtimeContext, baseline, solarKw, pw);
        byKey.set(scenario.finalSolarKw.toFixed(6) + "|" + scenario.finalPowerwalls, scenario);
      });
    });

    // Always include explicit no-upgrade candidate.
    const noUpgrade = buildUpgradeScenario(runtimeContext, baseline, baseline.baseSolarKw, baseline.basePowerwalls);
    byKey.set(noUpgrade.finalSolarKw.toFixed(6) + "|" + noUpgrade.finalPowerwalls, noUpgrade);

    const results = Array.from(byKey.values()).sort(compareUpgradeObjective);
    const first = results[0] || null;
    const noUpgradeRecommended = !!first && first.incrementalNpv <= 1e-6;
    const best = noUpgradeRecommended
      ? (results.find((row) => row.isNoUpgrade) || first)
      : first;

    return {
      error: null,
      objective: "max_incremental_npv",
      baseline,
      solarCandidates,
      powerwallCandidates,
      results,
      best,
      noUpgradeRecommended
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
        deltaAnnualBenefit: next.incrementalAnnualBenefit - prev.incrementalAnnualBenefit,
        deltaNpv: next.incrementalNpv - prev.incrementalNpv,
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
