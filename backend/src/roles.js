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

// Demande d'achat (DA) rules, copied from the desktop app (demande_achat.cs /
// menu_demande_achat.cs / creer_da.cs / liste_da.cs):
//  - everybody can create a DA except Administrateur (the desktop hides the
//    "create" screen for that role: it only reviews DAs),
//  - only these roles can create a DA on behalf of another user (the desktop
//    shows the "demandeur" dropdown just for them),
//  - these roles are the ones who see and review newly created DAs.
const DA_CREATE_EXCLUDED_ROLES = ['Administrateur'];
const DA_ON_BEHALF_ROLES = ['Responsable Achat', 'Responsable Méthode', 'Responsable Magasin'];
const DA_REVIEW_ROLES = ['Administrateur', 'Responsable Méthode', 'Responsable Magasin', 'Responsable Achat'];

function canCreateDa(fonction) {
  return !DA_CREATE_EXCLUDED_ROLES.includes((fonction || '').trim());
}

function canCreateDaForOthers(fonction) {
  return DA_ON_BEHALF_ROLES.includes((fonction || '').trim());
}

// Atelier (ordres de fabrication, OF): in the desktop app every atelier screen
// hides its save/receive buttons for the DGA role (read-only), and nobody else
// is restricted. Same rule here.
const ATELIER_READONLY_ROLES = ['DGA'];

function canWriteAtelier(fonction) {
  return !ATELIER_READONLY_ROLES.includes((fonction || '').trim());
}

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

module.exports = {
  ADMIN_ROLES, MANAGER_ROLES, DA_REVIEW_ROLES,
  isManager, isAdmin, canCreateDa, canCreateDaForOthers, canWriteAtelier, requireRole
};
