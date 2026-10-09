// Бесплатный Apple ID (SideStore) не умеет пуш-уведомления с сервера.
// Локальные уведомления работают и без этого права, поэтому убираем aps-environment.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
