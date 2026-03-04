// Simple in-memory conversation store
// In production, swap this for a database (e.g. Supabase, MongoDB, or even a JSON file)

const conversations = new Map();

const getConversation = (phoneNumber) => {
  return conversations.get(phoneNumber) || [];
};

const addMessage = (phoneNumber, role, content) => {
  const history = getConversation(phoneNumber);
  history.push({ role, content });
  conversations.set(phoneNumber, history);
  return history;
};

const clearConversation = (phoneNumber) => {
  conversations.delete(phoneNumber);
};

const getAllConversations = () => {
  return Object.fromEntries(conversations);
};

module.exports = { getConversation, addMessage, clearConversation, getAllConversations };
