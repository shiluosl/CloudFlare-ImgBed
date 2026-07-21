import { authenticate, AUTH_SCOPE } from '../../utils/auth/authCore.js';
import { fetchSecurityConfig } from '../../utils/sysConfig.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { validateApiToken } from '../../utils/auth/tokenValidator.js';

// V3 private files default to deny. The legacy auth helper intentionally
// permits USER access when no user auth code is configured, which is useful
// for legacy public behavior but unsafe for a private logical file.
export async function authorizePrivateV3Read({ env, request, file, authenticateFn = authenticate, fetchSecurityConfigFn = fetchSecurityConfig, validateApiTokenFn = validateApiToken, getDatabaseFn = getDatabase }) {
  if (Number(file?.is_public) === 1 || file?.is_public === true) return true;

  const security = await fetchSecurityConfigFn(env);
  const authCodeConfigured = configured(security?.auth?.user?.authCode);
  const adminConfigured = configured(security?.auth?.admin?.adminUsername) || configured(security?.auth?.admin?.adminPassword);
  if (!authCodeConfigured && !adminConfigured) {
    const token = await validateApiTokenFn(request, getDatabaseFn(env), null);
    return token?.valid === true;
  }
  const result = await authenticateFn({
    env,
    request,
    url: new URL(request.url),
    authScope: authCodeConfigured ? AUTH_SCOPE.USER : AUTH_SCOPE.ADMIN,
  });

  return result?.authorized === true;
}

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
