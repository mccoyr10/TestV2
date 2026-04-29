const form = document.getElementById('calculator-form');
const result = document.getElementById('result');

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const currentAge = Number(document.getElementById('currentAge').value);
  const retirementAge = Number(document.getElementById('retirementAge').value);
  const currentSavings = Number(document.getElementById('currentSavings').value);
  const monthlyContribution = Number(document.getElementById('monthlyContribution').value);
  const annualReturn = Number(document.getElementById('annualReturn').value) / 100;

  if (retirementAge <= currentAge) {
    result.innerHTML = '<h2>Projection</h2><p>Retirement age must be greater than current age.</p>';
    return;
  }

  const yearsToGrow = retirementAge - currentAge;
  const monthlyRate = annualReturn / 12;
  const months = yearsToGrow * 12;

  let total = currentSavings;
  for (let i = 0; i < months; i += 1) {
    total = total * (1 + monthlyRate) + monthlyContribution;
  }

  const totalContributions = currentSavings + monthlyContribution * months;
  const investmentGrowth = total - totalContributions;

  result.innerHTML = `
    <h2>Projection</h2>
    <p>By age <strong>${retirementAge}</strong>, you could have approximately <strong>${money.format(total)}</strong>.</p>
    <ul>
      <li>Total contributions: ${money.format(totalContributions)}</li>
      <li>Estimated investment growth: ${money.format(investmentGrowth)}</li>
      <li>Years invested: ${yearsToGrow}</li>
    </ul>
  `;
});
