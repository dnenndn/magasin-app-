// Central place for role names and permission groups, so every route checks
// against the same definitions. If your utilisateur.fonction values differ
// from these exact French strings, this is the only file you need to edit.
//
// IMPORTANT: these must match backend AND frontend. The frontend
// (www/index.html) keeps its own copy of MANAGER_ROLES/ADMIN_ROLES for UI
// purposes (which tabs to show) - if you rename a role here, update it
// there too (search for "MANAGER_ROLES" in index.html).

const ADMIN_ROLES = ['Administrateur'];

// Can create BSM/BRM auto-approved (no validation needed), can validate
// other people's pending BSM/BRM, can access Réception and the
// validation/history screens. Includes admins implicitly.
const MANAGER_ROLES = ['Administrateur', 'Responsable Méthode', 'Responsable Magasin', 'Magasinier'];

function isManager(fonction) {
  return MANAGER_ROLES.includes((fonction || '').trim());
}

function isAdmin(fonction) {
  return ADMIN_ROLES.includes((fonction || '').trim());
}

// Express middleware factory: requireRole(MANAGER_ROLES) or requireRole(ADMIN_ROLES).
// Must run after requireAuth (needs req.user.fonction).
function requireRole(allowedRoles) {
  return (req, res, next) => {
    const fonction = (req.user?.fonction || '').trim();
    if (!allowedRoles.includes(fonction)) {
      return res.status(403).json({ error: "Vous n'avez pas les droits pour cette action." });
    }
    next();
  };
}

module.exports = { ADMIN_ROLES, MANAGER_ROLES, isManager, isAdmin, requireRole };
