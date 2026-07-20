function roundRub(value) {
  return Number(value.toFixed(2));
}

export function evaluateBudget({
  dailyLimitRub,
  monthlyLimitRub,
  currentDailyRub,
  currentMonthlyRub,
  estimatedRub,
}) {
  const remainingDailyRub = roundRub(dailyLimitRub - currentDailyRub - estimatedRub);
  const remainingMonthlyRub = roundRub(monthlyLimitRub - currentMonthlyRub - estimatedRub);

  if (remainingDailyRub < 0) {
    return {
      allowed: false,
      reason: "daily_budget_exceeded",
      remainingDailyRub,
      remainingMonthlyRub,
    };
  }

  if (remainingMonthlyRub < 0) {
    return {
      allowed: false,
      reason: "monthly_budget_exceeded",
      remainingDailyRub,
      remainingMonthlyRub,
    };
  }

  return {
    allowed: true,
    reason: null,
    remainingDailyRub,
    remainingMonthlyRub,
  };
}
