// DisruptionIQ — Dashboard Visualisations with Chart.js
document.addEventListener('DOMContentLoaded', function () {
  const severityCanvas = document.getElementById('severityChart');
  const shipmentsCanvas = document.getElementById('shipmentsChart');
  const riskCanvas = document.getElementById('riskDistributionChart');

  if (!severityCanvas && !shipmentsCanvas && !riskCanvas) {
    return;
  }

  // Fetch real aggregated data from Flask backend
  fetch('/api/dashboard-charts')
    .then((response) => response.json())
    .then((data) => {
      // 1. Disruptions by Severity Doughnut Chart
      if (severityCanvas) {
        const sevData = data.disruptions_by_severity || { labels: [], data: [] };
        const totalDisruptions = sevData.data.reduce((a, b) => a + b, 0);

        new Chart(severityCanvas.getContext('2d'), {
          type: 'doughnut',
          data: {
            labels: sevData.labels,
            datasets: [{
              data: totalDisruptions > 0 ? sevData.data : [1],
              backgroundColor: totalDisruptions > 0 ? [
                '#F87171', // Critical (Coral)
                '#F5B84B', // High (Gold)
                '#38BDF8', // Medium (Sky)
                '#34D399', // Low (Teal)
              ] : ['rgba(148, 163, 184, 0.2)'],
              borderColor: '#172235',
              borderWidth: 2,
              hoverOffset: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: '#94A3B8',
                  font: { size: 11 },
                  padding: 12
                }
              },
              tooltip: {
                enabled: totalDisruptions > 0,
                callbacks: {
                  label: function (context) {
                    return ` ${context.label}: ${context.raw} disruptions`;
                  }
                }
              }
            },
            cutout: '70%'
          }
        });
      }

      // 2. Order Risk Distribution Chart
      if (riskCanvas) {
        const riskData = data.risk_distribution || { labels: ['Critical', 'High', 'Medium', 'Low'], data: [0, 0, 0, 0] };
        const totalRiskOrders = riskData.data.reduce((a, b) => a + b, 0);

        new Chart(riskCanvas.getContext('2d'), {
          type: 'doughnut',
          data: {
            labels: riskData.labels,
            datasets: [{
              data: totalRiskOrders > 0 ? riskData.data : [1],
              backgroundColor: totalRiskOrders > 0 ? [
                '#EF4444', // Critical
                '#F59E0B', // High
                '#0EA5E9', // Medium
                '#10B981', // Low
              ] : ['rgba(148, 163, 184, 0.2)'],
              borderColor: '#172235',
              borderWidth: 2,
              hoverOffset: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: '#94A3B8',
                  font: { size: 11 },
                  padding: 12
                }
              },
              tooltip: {
                enabled: totalRiskOrders > 0,
                callbacks: {
                  label: function (context) {
                    return ` ${context.label} Risk: ${context.raw} orders`;
                  }
                }
              }
            },
            cutout: '70%'
          }
        });
      }

      // 3. Shipments by Status Bar Chart
      if (shipmentsCanvas) {
        const shipData = data.shipments_by_status || { labels: [], data: [] };
        
        new Chart(shipmentsCanvas.getContext('2d'), {
          type: 'bar',
          data: {
            labels: shipData.labels,
            datasets: [{
              label: 'Shipment Count',
              data: shipData.data,
              backgroundColor: [
                '#F5B84B', // In Transit (Gold)
                '#F87171', // Delayed (Coral)
                '#64748B', // Scheduled (Slate)
                '#34D399', // Delivered (Teal)
              ],
              borderRadius: 6,
              barThickness: 24
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: false
              },
              tooltip: {
                callbacks: {
                  label: function (context) {
                    return ` ${context.raw} active shipments`;
                  }
                }
              }
            },
            scales: {
              x: {
                grid: {
                  display: false
                },
                ticks: {
                  color: '#94A3B8',
                  font: { size: 11 }
                }
              },
              y: {
                beginAtZero: true,
                grid: {
                  color: 'rgba(255, 255, 255, 0.06)'
                },
                ticks: {
                  color: '#94A3B8',
                  stepSize: 1,
                  font: { size: 11 }
                }
              }
            }
          }
        });
      }
    })
    .catch((err) => {
      console.warn('DisruptionIQ: Could not load chart telemetry data:', err);
    });
});
