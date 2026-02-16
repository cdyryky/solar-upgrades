(function initUiModule(global) {
  "use strict";

  const namespace = global.SolarPlanner = global.SolarPlanner || {};

  function usd(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0
    }).format(value);
  }

  function usdPrecise(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2
    }).format(value);
  }

  function usdSigned(value) {
    const amount = usdPrecise(Math.abs(value));
    if (Math.abs(value) < 0.005) return "$0.00";
    return (value > 0 ? "+" : "-") + amount;
  }

  function num(value, digits) {
    return Number(value).toFixed(digits);
  }

  function fmtPayback(years) {
    return Number.isFinite(years) ? (num(years, 1) + "y") : "No payback";
  }

  function fmtIrr(irr) {
    return Number.isFinite(irr) ? (num(irr * 100, 1) + "%") : "N/A";
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  function metricCard(label, value) {
    return (
      "<article class=\"metric-card\">" +
        "<p class=\"metric-label\">" + label + "</p>" +
        "<p class=\"metric-value\">" + value + "</p>" +
      "</article>"
    );
  }

  function pill(label, kind) {
    return "<span class=\"pill " + kind + "\">" + label + "</span>";
  }

  function renderKpis(dom, state) {
    const summary = state.summary;
    const expansion = state.expansion;

    if (!summary || summary.error || !summary.bestUpgrade) {
      setText(dom.kpiBaseSystem, "No valid result");
      setText(dom.kpiBaseDetail, "Check required inputs and candidate ranges.");
      setText(dom.kpiUpgradeSystem, "--");
      setText(dom.kpiUpgradeDetail, "--");
      setText(dom.kpiIncrementalNpv, "--");
      setText(dom.kpiIncrementalNpvDetail, "--");
      setText(dom.kpiExpansion, "--");
      setText(dom.kpiExpansionDetail, "--");
      if (dom.noUpgradeBanner) {
        dom.noUpgradeBanner.classList.add("hidden");
        dom.noUpgradeBanner.textContent = "";
      }
      return;
    }

    const baseline = summary.baseline;
    const best = summary.bestUpgrade;
    const showNoUpgrade = !!summary.noUpgradeRecommended || !!best.isNoUpgrade;
    const showBatteryOnlyUpgrade = !showNoUpgrade && best.addedSolarKw <= 1e-6 && best.finalPowerwalls > baseline.basePowerwalls;

    setText(dom.kpiBaseSystem, num(baseline.baseSolarKw, 2) + " kW + 0 PW");
    setText(dom.kpiBaseDetail, "Builder quote: " + usd(baseline.baseQuote));

    if (showNoUpgrade) {
      setText(dom.kpiUpgradeSystem, "No Tesla upgrade");
      setText(dom.kpiUpgradeDetail, "Stay at Builder base.");
    } else if (showBatteryOnlyUpgrade) {
      setText(dom.kpiUpgradeSystem, num(best.finalSolarKw, 2) + " kW + " + best.finalPowerwalls + " PW");
      setText(dom.kpiUpgradeDetail, "Battery-only Tesla upgrade (solar unchanged).");
    } else {
      setText(dom.kpiUpgradeSystem, num(best.finalSolarKw, 2) + " kW + " + best.finalPowerwalls + " PW");
      setText(dom.kpiUpgradeDetail, "Tesla incremental capex: " + usd(best.incrementalCapex));
    }

    setText(dom.kpiIncrementalNpv, usd(best.incrementalLeveredNpv));
    setText(
      dom.kpiIncrementalNpvDetail,
      "Annual operating benefit: " + usdSigned(best.incrementalAnnualOperatingBenefit) +
      " | Monthly cashflow delta: " + usdSigned(best.incrementalMonthlyEnergyDelta) +
      " + " + usdSigned(best.monthlyFinancingCostDelta) +
      " = " + usdSigned(best.incrementalMonthlyNetOutflow)
    );

    if (expansion && !expansion.error) {
      const additionalPw = Math.max(0, expansion.recommendedPowerwalls - expansion.startPowerwalls);
      setText(dom.kpiExpansion, additionalPw > 0 ? ("Add " + additionalPw + " PW") : "No PW expansion");
      setText(dom.kpiExpansionDetail, "Global best PW: " + expansion.recommendedPowerwalls + " (aligned)");
    } else {
      setText(dom.kpiExpansion, "Expansion unavailable");
      setText(dom.kpiExpansionDetail, "Check expansion inputs.");
    }

    if (dom.noUpgradeBanner) {
      if (showNoUpgrade) {
        dom.noUpgradeBanner.classList.remove("hidden");
        dom.noUpgradeBanner.textContent = "No-upgrade recommended: best incremental levered NPV is non-positive.";
      } else {
        dom.noUpgradeBanner.classList.add("hidden");
        dom.noUpgradeBanner.textContent = "";
      }
    }
  }

  function renderBaselineUpgradePanel(dom, state) {
    const summary = state.summary;
    if (!summary || summary.error || !summary.bestUpgrade) {
      setText(dom.scenarioLabel, "No baseline-upgrade recommendation available.");
      dom.scenarioMetrics.innerHTML = "";
      return;
    }

    const baseline = summary.baseline;
    const best = summary.bestUpgrade;
    const showNoUpgrade = !!summary.noUpgradeRecommended || !!best.isNoUpgrade;

    setText(
      dom.scenarioLabel,
      "Hourly dispatch model aligned with v2.6.1. Recommendation is conditional on selected Builder base."
    );

    dom.scenarioMetrics.innerHTML = [
      metricCard("Builder base preset", baseline.presetLabel),
      metricCard("Builder base quote", usd(baseline.baseQuote)),
      metricCard("Builder base solar", num(baseline.annual.annualSolarGenerationKwh, 0) + " kWh"),
      metricCard("Builder base utility after", usd(baseline.annual.annualUtilityBillAfter / 12) + "/mo"),
      metricCard(
        "Upgrade final system",
        showNoUpgrade
          ? "No Tesla upgrade"
          : (showBatteryOnlyUpgrade
            ? (num(best.finalSolarKw, 2) + " kW + " + best.finalPowerwalls + " PW (battery-only)")
            : (num(best.finalSolarKw, 2) + " kW + " + best.finalPowerwalls + " PW"))
      ),
      metricCard("Tesla-added solar", num(best.teslaAddedSolarKwh, 0) + " kWh"),
      metricCard("Solar add size", num(best.addedSolarKw, 2) + " kW"),
      metricCard("Tesla solar upgrade cost", usd(best.solarUpgradeCost)),
      metricCard("Tesla battery upgrade cost", usd(best.batteryUpgradeCost)),
      metricCard("Incremental capex", usd(best.incrementalCapex)),
      metricCard("Annual operating benefit (pre-financing)", usdSigned(best.incrementalAnnualOperatingBenefit)),
      metricCard("Monthly energy delta", usdSigned(best.incrementalMonthlyEnergyDelta)),
      metricCard("Monthly financing delta", usdSigned(best.monthlyFinancingCostDelta)),
      metricCard("Monthly cashflow delta (incl financing)", usdSigned(best.incrementalMonthlyNetOutflow)),
      metricCard("Incremental levered NPV", usd(best.incrementalLeveredNpv)),
      metricCard("Incremental levered payback", fmtPayback(best.incrementalLeveredPaybackYears)),
      metricCard("Incremental levered IRR", fmtIrr(best.incrementalLeveredIrr)),
      metricCard("Incremental unlevered NPV", usd(best.incrementalNpv))
    ].join("");
  }

  function renderExpansionTable(dom, state) {
    const expansion = state.expansion;
    if (!expansion || expansion.error) {
      setText(dom.expansionSummary, expansion && expansion.error ? expansion.error : "Expansion data unavailable.");
      dom.expansionTableBody.innerHTML = "";
      return;
    }

    setText(
      dom.expansionSummary,
      "Explanatory marginal path 0->1->2 PW (global-best recommendation = " + expansion.recommendedPowerwalls + " PW)."
    );

    if (!expansion.steps.length) {
      dom.expansionTableBody.innerHTML = "<tr><td colspan=\"8\">No expansion steps available.</td></tr>";
      return;
    }

    dom.expansionTableBody.innerHTML = expansion.steps.map((step) => {
      const action = step.onRecommendedPath ? pill("On best path", "good") : pill("Off best path", "warn");
      return (
        "<tr>" +
          "<td>" + step.fromPowerwalls + " -> " + step.toPowerwalls + " PW</td>" +
          "<td>" + num(step.bestSolarKw, 2) + "</td>" +
          "<td>" + num(step.annualSolarKwh, 0) + "</td>" +
          "<td>" + num(step.teslaAddedSolarKwh, 0) + "</td>" +
          "<td>" + usdSigned(step.deltaAnnualBenefit) + "</td>" +
          "<td>" + usdSigned(step.deltaNpv) + "</td>" +
          "<td>" + usdSigned(step.deltaMonthlyOutflow) + "</td>" +
          "<td>" + action + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderTopScenarios(dom, state) {
    const optimization = state.optimization;
    if (!optimization || optimization.error || !optimization.results.length) {
      setText(dom.topScenarioHint, "No Tesla upgrade scenarios to rank.");
      dom.topScenarioTableBody.innerHTML = "";
      return;
    }

    const invalidNote = optimization.invalidScenarioCount > 0
      ? (" | skipped " + optimization.invalidScenarioCount + " invalid scenarios")
      : "";
    const noUpgradeNote = optimization.noUpgradeRecommended
      ? " | recommendation: no Tesla upgrade"
      : "";

    setText(
      dom.topScenarioHint,
      optimization.solarCandidates.length + " solar candidates x " +
      optimization.powerwallCandidates.length + " PW options, ranked by incremental levered NPV" + invalidNote + noUpgradeNote + "."
    );

    dom.topScenarioTableBody.innerHTML = optimization.results.slice(0, 10).map((row, idx) => {
      return (
        "<tr>" +
          "<td>" + (idx + 1) + "</td>" +
          "<td>" + (row.isNoUpgrade ? ("Baseline " + num(row.finalSolarKw, 2)) : num(row.finalSolarKw, 2)) + "</td>" +
          "<td>" + (row.isNoUpgrade ? "0 (no-upgrade)" : row.finalPowerwalls) + "</td>" +
          "<td>" + num(row.addedSolarKw, 2) + "</td>" +
          "<td>" + num(row.teslaAddedSolarKwh, 0) + "</td>" +
          "<td>" + usd(row.incrementalCapex) + "</td>" +
          "<td>" + usdSigned(row.incrementalAnnualOperatingBenefit) + "</td>" +
          "<td>" + usdSigned(row.incrementalMonthlyNetOutflow) + "</td>" +
          "<td>" + usd(row.incrementalLeveredNpv) + "</td>" +
          "<td>" + fmtPayback(row.incrementalLeveredPaybackYears) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAll(dom, state) {
    renderKpis(dom, state);
    renderBaselineUpgradePanel(dom, state);
    renderExpansionTable(dom, state);
    renderTopScenarios(dom, state);
  }

  namespace.ui = {
    usd,
    usdPrecise,
    usdSigned,
    num,
    fmtPayback,
    renderAll
  };
})(window);
