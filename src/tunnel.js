const ngrok = require('@ngrok/ngrok');
const { setBotSetting } = require('./db');

let activeListener = null;

async function startNgrokTunnel({ port = 3000, authtoken = null, domain = null, db = null } = {}) {
  const token = authtoken || process.env.NGROK_AUTHTOKEN;
  const customDomain = domain || process.env.NGROK_DOMAIN;

  if (!token) {
    console.warn('\n⚠️ [NGROK] Tunnel skipped: NGROK_AUTHTOKEN is not set in .env.');
    console.warn('   Get your free authtoken at: https://dashboard.ngrok.com/get-started/your-authtoken');
    console.warn('   Then add it to your .env file: NGROK_AUTHTOKEN=your_token_here\n');
    return { success: false, reason: 'MISSING_AUTHTOKEN' };
  }

  try {
    const forwardOptions = {
      addr: port,
      authtoken: token
    };

    if (customDomain) {
      forwardOptions.domain = customDomain;
    }

    activeListener = await ngrok.forward(forwardOptions);
    const publicUrl = activeListener.url();

    console.log('\n====================================================');
    console.log('🚀 NGROK PUBLIC TUNNEL ESTABLISHED:');
    console.log(`   > Public URL:       ${publicUrl}`);
    console.log(`   > Mobile Dashboard: ${publicUrl}`);
    console.log(`   > Telecaller CRM:   ${publicUrl}/crm`);
    console.log('====================================================\n');

    if (db) {
      try {
        setBotSetting(db, 'public_url', publicUrl);
      } catch {}
    }

    return { success: true, url: publicUrl, listener: activeListener };
  } catch (err) {
    console.error('❌ [NGROK] Failed to establish tunnel:', err.message);
    return { success: false, error: err.message };
  }
}

async function stopNgrokTunnel() {
  if (activeListener) {
    try {
      await activeListener.close();
      console.log('🛑 [NGROK] Tunnel closed.');
    } catch {}
    activeListener = null;
  }
}

module.exports = {
  startNgrokTunnel,
  stopNgrokTunnel
};
