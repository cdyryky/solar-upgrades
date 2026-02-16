(function initModelModule(global) {
  "use strict";

  const namespace = global.SolarPlanner = global.SolarPlanner || {};
  const engine = namespace.engineV261;

  if (!engine) {
    throw new Error("engine-v261.js must load before model.js");
  }

  function asFinite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function mortgagePayment(principal, aprPct, years) {
    const safePrincipal = Math.max(0, asFinite(principal, 0));
    const safeYears = Math.max(1, Math.floor(asFinite(years, 15)));
    const apr = Math.max(0, asFinite(aprPct, 0)) / 100;
    if (safePrincipal <= 0) return 0;
    if (apr <= 0) return safePrincipal / (safeYears * 12);

    const r = apr / 12;
    const n = safeYears * 12;
    return safePrincipal * (r / (1 - Math.pow(1 + r, -n)));
  }

  function irrFromCashflows(cashflows) {
    if (!Array.isArray(cashflows) || cashflows.length < 2) return null;
    const hasPositive = cashflows.some((v) => v > 0);
    const hasNegative = cashflows.some((v) => v < 0);
    if (!hasPositive || !hasNegative) return null;

    const npvAt = (rate) => cashflows.reduce((sum, cf, idx) => sum + (cf / Math.pow(1 + rate, idx)), 0);

    let low = -0.99;
    let high = 1;
    let lowVal = npvAt(low);
    let highVal = npvAt(high);
    let guard = 0;

    while (lowVal * highVal > 0 && guard < 32 && high < 200) {
      high *= 1.6;
      highVal = npvAt(high);
      guard += 1;
    }

    if (!Number.isFinite(lowVal) || !Number.isFinite(highVal) || lowVal * highVal > 0) {
      return null;
    }

    for (let i = 0; i < 120; i += 1) {
      const mid = (low + high) / 2;
      const midVal = npvAt(mid);
      if (!Number.isFinite(midVal)) return null;
      if (Math.abs(midVal) < 1e-8) return mid;
      if (lowVal * midVal <= 0) {
        high = mid;
        highVal = midVal;
      } else {
        low = mid;
        lowVal = midVal;
      }
    }

    return (low + high) / 2;
  }

  function getTeslaSolarRatePerKw(runtimeContext, finalSolarKw) {
    return finalSolarKw < 10
      ? Math.max(0, asFinite(runtimeContext.pricing.teslaSolarRates.below10, 2760))
      : Math.max(0, asFinite(runtimeContext.pricing.teslaSolarRates.atLeast10, 2660));
  }

  function getTeslaBatteryTotalCost(runtimeContext, powerwallsRaw) {
    const powerwalls = Math.max(0, Math.floor(asFinite(powerwallsRaw, 0)));
    const totals = runtimeContext.pricing.teslaBatteryTotals;
    if (powerwalls <= 0) return totals[0];
    if (powerwalls === 1) return totals[1];
    return totals[2];
  }

  function computeTeslaUpgradeCosts(runtimeContext, finalSolarKwRaw, finalPowerwallsRaw) {
    const baseline = runtimeContext.baseline;
    const finalSolarKw = Math.max(baseline.baseSolarKw, asFinite(finalSolarKwRaw, baseline.baseSolarKw));
    const finalPowerwalls = clamp(Math.floor(asFinite(finalPowerwallsRaw, baseline.basePowerwalls)), 0, 2);

    const addedSolarKw = Math.max(0, finalSolarKw - baseline.baseSolarKw);
    const solarRatePerKw = getTeslaSolarRatePerKw(runtimeContext, finalSolarKw);
    const solarUpgradeCost = addedSolarKw * solarRatePerKw;

    const batteryTotalBase = getTeslaBatteryTotalCost(runtimeContext, baseline.basePowerwalls);
    const batteryTotalFinal = getTeslaBatteryTotalCost(runtimeContext, finalPowerwalls);
    const batteryUpgradeCost = Math.max(0, batteryTotalFinal - batteryTotalBase);

    return {
      finalSolarKw,
      finalPowerwalls,
      addedSolarKw,
      solarRatePerKw,
      solarUpgradeCost,
      batteryUpgradeCost,
      incrementalCapex: solarUpgradeCost + batteryUpgradeCost
    };
  }

  function projectIncrementalReturns(runtimeContext, incrementalCapexRaw, incrementalAnnualBenefitRaw, candidatePowerwallsRaw) {
    const analysis = runtimeContext.simulationInputs.analysis;

    const incrementalCapex = Math.max(0, asFinite(incrementalCapexRaw, 0));
    const incrementalAnnualBenefit = asFinite(incrementalAnnualBenefitRaw, 0);
    const candidatePowerwalls = Math.max(0, Math.floor(asFinite(candidatePowerwallsRaw, 0)));

    const years = Math.max(1, Math.floor(asFinite(analysis.years, 15)));
    const discountRate = clamp(asFinite(analysis.discountRate, 0.05), 0, 2);
    const utilityEscalation = clamp(asFinite(analysis.utilityEscalation, 0.03), 0, 1);
    const solarDegradation = clamp(asFinite(analysis.solarDegradation, 0.005), 0, 1);
    const batteryDegradation = clamp(asFinite(analysis.batteryDegradation, 0.02), 0, 1);

    const batteryFactor = candidatePowerwalls > 0 ? (1 - batteryDegradation) : 1;
    const annualScale = (1 + utilityEscalation) * (1 - solarDegradation) * batteryFactor;

    let npv = -incrementalCapex;
    let cumulative = -incrementalCapex;
    let paybackYears = Number.POSITIVE_INFINITY;
    const cashflows = [-incrementalCapex];

    for (let year = 1; year <= years; year += 1) {
      const annualBenefit = incrementalAnnualBenefit * Math.pow(annualScale, year - 1);
      cashflows.push(annualBenefit);
      cumulative += annualBenefit;
      npv += annualBenefit / Math.pow(1 + discountRate, year);
      if (!Number.isFinite(paybackYears) && cumulative >= 0) {
        paybackYears = year;
      }
    }

    return {
      npv,
      paybackYears,
      cumulative,
      irr: irrFromCashflows(cashflows)
    };
  }

  function buildRuntimeContext(rawInputs, climateSnapshot) {
    const preset = String(rawInputs.sizing.builderBasePresetKw || "3.95");
    const baseSolarKw = preset === "5.53" ? 5.53 : 3.95;
    const baseQuote = baseSolarKw === 5.53
      ? Math.max(0, asFinite(rawInputs.baselineQuotes.quote553, 18110))
      : Math.max(0, asFinite(rawInputs.baselineQuotes.quote395, 13710));

    const simulationInputs = engine.buildSimulationInputs(rawInputs, climateSnapshot);
    const pw1 = Math.max(0, asFinite(rawInputs.pricing.teslaBatteryCosts[1], 3900));
    const pw2 = Math.max(0, asFinite(rawInputs.pricing.teslaBatteryCosts[2], 9700));

    return {
      baseline: {
        baseSolarKw,
        basePowerwalls: 0,
        baseQuote,
        presetLabel: baseSolarKw === 5.53 ? "5.53 kW (14 modules)" : "3.95 kW (10 modules)"
      },
      pricing: {
        teslaSolarRates: {
          below10: Math.max(0, asFinite(rawInputs.pricing.teslaSolarRates.below10, 2760)),
          atLeast10: Math.max(0, asFinite(rawInputs.pricing.teslaSolarRates.atLeast10, 2660))
        },
        teslaBatteryTotals: {
          0: 0,
          1: pw1,
          2: pw2
        }
      },
      financing: {
        aprPct: Math.max(0, asFinite(rawInputs.financing.aprPct, 6)),
        loanYears: Math.max(1, Math.floor(asFinite(rawInputs.financing.loanYears, 15)))
      },
      simulationInputs,
      climateSnapshot,
      rawInputs
    };
  }

  namespace.model = {
    asFinite,
    clamp,
    mortgagePayment,
    getTeslaSolarRatePerKw,
    getTeslaBatteryTotalCost,
    computeTeslaUpgradeCosts,
    projectIncrementalReturns,
    buildRuntimeContext
  };
})(window);
