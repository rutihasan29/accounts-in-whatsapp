const { recordExistingContact } = require('./db');

async function syncExistingInboxContacts({ client, db, resolveCustomerPhone }) {
  if (!client || !db) return { syncedChats: 0, syncedContacts: 0, totalProtected: 0 };

  console.log('[SYNC] Starting inbox and contacts scan to protect existing chats from welcome demo...');
  let syncedChats = 0;
  let syncedContacts = 0;
  const processedPhones = new Set();

  // 1. Fetch chats from WhatsApp inbox (via direct in-page store or fallback to getChats)
  let chats = [];
  if (client?.pupPage && typeof client.pupPage.evaluate === 'function') {
    try {
      chats = await client.pupPage.evaluate(() => {
        try {
          const chatCollection = window.require('WAWebCollections')?.Chat;
          if (!chatCollection) return [];
          return chatCollection.getModelsArray().map(c => {
            const rawId = c.id?._serialized || '';
            const isGrp = Boolean(c.isGroup) || (typeof c.id?.isGroup === 'function' ? c.id.isGroup() : false) || rawId.endsWith('@g.us');
            const isBcast = Boolean(c.isBroadcast) || (typeof c.id?.isBroadcast === 'function' ? c.id.isBroadcast() : false) || rawId.endsWith('@broadcast');
            const isNl = rawId.endsWith('@newsletter');
            return {
              id: { _serialized: rawId },
              name: c.name || c.formattedTitle || null,
              isGroup: isGrp,
              isBroadcast: isBcast,
              isNewsletter: isNl,
              timestamp: c.t || null
            };
          });
        } catch (e) {
          return [];
        }
      });
      console.log(`[SYNC] Extracted ${chats?.length || 0} chats directly from in-page memory.`);
    } catch (evalErr) {
      console.warn('[SYNC] pupPage evaluate failed, falling back to client.getChats:', evalErr.message);
    }
  }

  // Fallback to client.getChats if in-page was empty or unavailable (e.g. in mock tests)
  if (!chats || chats.length === 0) {
    try {
      if (typeof client.getChats === 'function') {
        chats = await client.getChats();
      }
    } catch (err) {
      console.warn('[SYNC] Fallback client.getChats error:', err.message);
    }
  }

  if (Array.isArray(chats)) {
    for (const chat of chats) {
      try {
        const rawId = chat.id?._serialized || '';
        if (!rawId) continue;
        if (chat.isGroup || chat.isBroadcast || chat.isNewsletter || rawId.endsWith('@g.us') || rawId.endsWith('@broadcast') || rawId.endsWith('@newsletter')) {
          continue;
        }
        if (client.info?.wid?._serialized && rawId === client.info.wid._serialized) {
          continue;
        }

        let phone = null;
        if (typeof resolveCustomerPhone === 'function') {
          phone = await resolveCustomerPhone({ client, recipient: rawId });
        }
        if (!phone && rawId.endsWith('@c.us')) {
          phone = rawId.split('@')[0].split(':')[0].replace(/\D/g, '');
        }

        if (phone) {
          const chatName = chat.name || null;
          const ts = chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null;
          recordExistingContact(db, { phone, name: chatName, timestamp: ts });
          processedPhones.add(phone);
          syncedChats++;
        }
      } catch {}
    }
  }

  // 2. Fetch contacts (via direct in-page store or fallback to getContacts)
  let contacts = [];
  if (client?.pupPage && typeof client.pupPage.evaluate === 'function') {
    try {
      contacts = await client.pupPage.evaluate(() => {
        try {
          const contactCollection = window.require('WAWebCollections')?.Contact;
          if (!contactCollection) return [];
          let getIsMyContact = null;
          try {
            getIsMyContact = window.require('WAWebContactGetters')?.getIsMyContact;
          } catch {}

          return contactCollection.getModelsArray().map(c => {
            const rawId = c.id?._serialized || '';
            let isMy = false;
            try {
              if (typeof getIsMyContact === 'function') isMy = getIsMyContact(c);
              else isMy = Boolean(c.isMyContact);
            } catch {}

            return {
              id: { _serialized: rawId },
              number: c.phoneNumber?.user || (rawId.endsWith('@c.us') ? rawId.split('@')[0].split(':')[0] : null),
              name: c.name || c.pushname || c.formattedName || null,
              isMyContact: isMy,
              isGroup: (typeof c.id?.isGroup === 'function' ? c.id.isGroup() : false) || rawId.endsWith('@g.us')
            };
          });
        } catch (e) {
          return [];
        }
      });
      console.log(`[SYNC] Extracted ${contacts?.length || 0} contacts directly from in-page memory.`);
    } catch (evalErr) {
      console.warn('[SYNC] pupPage evaluate contacts failed:', evalErr.message);
    }
  }

  // Fallback to client.getContacts if in-page was empty or unavailable
  if (!contacts || contacts.length === 0) {
    try {
      if (typeof client.getContacts === 'function') {
        contacts = await client.getContacts();
      }
    } catch (err) {
      console.warn('[SYNC] Fallback client.getContacts error:', err.message);
    }
  }

  if (Array.isArray(contacts)) {
    for (const contact of contacts) {
      try {
        if (contact.isGroup) continue;
        if (contact.isMyContact === true) {
          let phone = null;
          if (contact.number && !contact.number.includes('@lid')) {
            phone = contact.number.replace(/\D/g, '');
          } else if (contact.id?._serialized?.endsWith('@c.us')) {
            phone = contact.id._serialized.split('@')[0].split(':')[0].replace(/\D/g, '');
          } else if (typeof resolveCustomerPhone === 'function') {
            phone = await resolveCustomerPhone({ client, recipient: contact.id?._serialized || '' });
          }

          if (phone) {
            const contactName = contact.name || contact.pushname || null;
            recordExistingContact(db, { phone, name: contactName });
            if (!processedPhones.has(phone)) {
              processedPhones.add(phone);
              syncedContacts++;
            }
          }
        }
      } catch {}
    }
  }

  const totalProtected = processedPhones.size;
  console.log(`[SYNC] Completed! Protected ${totalProtected} existing contacts (${syncedChats} inbox chats, ${syncedContacts} additional saved contacts) from receiving welcome demo.`);
  return { syncedChats, syncedContacts, totalProtected };
}

module.exports = {
  syncExistingInboxContacts
};
