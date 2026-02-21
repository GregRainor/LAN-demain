const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// Replace standard <style> section with external stylesheet
const cssMatchPattern = /<style>[\s\S]*?<\/style>/;
html = html.replace(cssMatchPattern, '<link rel="stylesheet" href="style.css">');

// Add luxury-panel classes
html = html.replace(/<div id="auth-container">/, '<div id="auth-container" class="luxury-panel">');
html = html.replace(/<div class="kpi-card">/g, '<div class="kpi-card luxury-panel">');
html = html.replace(/<div class="results-container">/, '<div class="results-container luxury-panel">');
html = html.replace(/<div class="form-container">/, '<div class="form-container luxury-panel">');
html = html.replace(/<section class="chart-wrapper animated-section"/, '<section class="chart-wrapper luxury-panel animated-section"');
html = html.replace(/<div class="modal-content">/, '<div class="modal-content luxury-panel">');

// Replace log out button style
html = html.replace(/<button id="logout-btn" style="[^"]*">/, '<button id="logout-btn">');

// Replace admin panel styling
html = html.replace(/<div id="admin-panel" style="display: none; background-color: rgba\(207, 102, 121, 0\.1\); border: 1px solid var\(--danger-color\); padding: 15px; border-radius: 8px; margin-bottom: 20px;">/, '<div id="admin-panel" class="luxury-panel" style="display: none; border-color: var(--danger-color); margin-bottom: 30px;">');
html = html.replace(/<h3 style="margin: 0 0 10px 0; text-align: left;">/, '<h3 style="margin: 0 0 15px 0; color: var(--danger-color);">');
html = html.replace(/<button id="reset-all-votes-btn" style="width: 100%; background-color: var\(--danger-color\); color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer;">/, `<button id="reset-all-votes-btn" style="width: 100%; background: transparent; color: var(--danger-color); border: 1px solid var(--danger-color); padding: 12px; cursor: pointer; font-family: 'Outfit', sans-serif; letter-spacing: 1px; transition: all 0.3s;" onmouseover="this.style.background='rgba(158,54,54,0.1)'" onmouseout="this.style.background='transparent'">`);

// Modify priority group text to span format for points
html = html.replace(/<h3>Priorité 1 \(5 pts\)<\/h3>/, '<h3>Priorité 1 <span>(5 pts)</span></h3>');
html = html.replace(/<h3>Priorité 2 \(3 pts\)<\/h3>/, '<h3>Priorité 2 <span>(3 pts)</span></h3>');
html = html.replace(/<h3>Priorité 3 \(2 pts\)<\/h3>/, '<h3>Priorité 3 <span>(2 pts)</span></h3>');
html = html.replace(/<h3>Autres \(1 pt\)<\/h3>/, '<h3>Autres <span>(1 pt)</span></h3>');

fs.writeFileSync('index.html', html);
console.log('Update completed.');
