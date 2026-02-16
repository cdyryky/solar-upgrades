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

    setText(dom.kpiBaseSystem, num(baseline.baseSolarKw, 2) + " kW + 0 PW");
    setText(dom.kpiBaseDetail, "Builder quote: " + usd(baseline.baseQuote));

    setText(dom.kpiUpgradeSystem, num(best.finalSolarKw, 2) + " kW + " + best.finalPowerwalls + " PW");
    setText(dom.kpiUpgradeDetail, "Tesla incremental capex: " + usd(best.incrementalCapex));

    setText(dom.kpiIncrementalNpv, usd(best.incrementalNpv));
    setText(
      dom.kpiIncrementalNpvDetail,
      "Annual delta: " + usdSigned(best.incrementalAnnualBenefit) + " | Monthly delta: " + usdSigned(best.incrementalMonthlyNetOutflow)
    );

    if (expansion && !expansion.error) {
      const additionalPw = Math.max(0, expansion.recommendedPowerwalls - expansion.startPowerwalls);
      setText(dom.kpiExpansion, additionalPw > 0 ? ("Add " + additionalPw + " PW") : "No PW expansion");
      setText(dom.kpiExpansionDetail, "Global best PW: " + expansion.recommendedPowerwalls + " (engine-aligned)");
    } else {
      setText(dom.kpiExpansion, "Expansion unavailable");
      setText(dom.kpiExpansionDetail, "Check expansion inputs.");
    }

    if (dom.noUpgradeBanner) {
      if (summary.noUpgradeRecommended) {
        dom.noUpgradeBanner.classList.remove("hidden");
        dom.noUpgradeBanner.textContent = "No-upgrade recommended: best incremental NPV is non-positive.";
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

    setText(dom.scenarioLabel, "Hourly dispatch model aligned with v2.6.1. Objective: max incremental NPV.");

    dom.scenarioMetrics.innerHTML = [
      metricCard("Builder base preset", baseline.presetLabel),
      metricCard("Builder base quote", usd(baseline.baseQuote)),
      metricCard("Builder base solar", num(baseline.annual.annualSolarGenerationKwh || 0, 0) + " kWh"),
      metricCard("Builder base utility after", usd((baseline.annual.annualUtilityBillAfter || 0) / 12) + "/mo"),
      metricCard("Upgrade final system", num(best.finalSolarKw, 2) + " kW + " + best.finalPowerwalls + " PW"),
      metricCard("Tesla-added solar", num(best.teslaAddedSolarKwh || 0, 0) + " kWh"),
      metricCard("Solar add size", num(best.addedSolarKw, 2) + " kW"),
      metricCard("Tesla solar upgrade cost", usd(best.solarUpgradeCost)),
      metricCard("Tesla battery upgrade cost", usd(best.batteryUpgradeCost)),
      metricCard("Incremental capex", usd(best.incrementalCapex)),
      metricCard("Incremental annual benefit", usdSigned(best.incrementalAnnualBenefit)),
      metricCard("Incremental monthly delta", usdSigned(best.incrementalMonthlyNetOutflow)),
      metricCard("Incremental NPV", usd(best.incrementalNpv)),
      metricCard("Incremental payback", fmtPayback(best.incrementalPaybackYears)),
      metricCard("Incremental IRR", fmtIrr(best.incrementalIrr)),
      metricCard("Total system cost proxy", usd(best.totalSystemCostProxy))
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

    setText(
      dom.topScenarioHint,
      optimization.solarCandidates.length + " solar candidates x " +
      optimization.powerwallCandidates.length + " PW options, ranked by incremental NPV."
    );

    dom.topScenarioTableBody.innerHTML = optimization.results.slice(0, 10).map((row, idx) => {
      return (
        "<tr>" +
          "<td>" + (idx + 1) + "</td>" +
          "<td>" + num(row.finalSolarKw, 2) + "</td>" +
          "<td>" + row.finalPowerwalls + "</td>" +
          "<td>" + num(row.addedSolarKw, 2) + "</td>" +
          "<td>" + num(row.teslaAddedSolarKwh || 0, 0) + "</td>" +
          "<td>" + usd(row.incrementalCapex) + "</td>" +
          "<td>" + usdSigned(row.incrementalAnnualBenefit) + "</td>" +
          "<td>" + usdSigned(row.incrementalMonthlyNetOutflow) + "</td>" +
          "<td>" + usd(row.incrementalNpv) + "</td>" +
          "<td>" + fmtPayback(row.incrementalPaybackYears) + "</td>" +
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
