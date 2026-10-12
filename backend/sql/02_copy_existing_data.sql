-- STEP 2 of 3 - run in SSMS, right before you restart the backend with the new code.
--
-- Copies what is currently stored in the ORIGINAL database's app_* tables
-- into the new GMAO_APP database, keeping the same ids (so already-approved
-- requests still point at the right BSM/BRM, and notification references
-- still match). Rows already copied are skipped, so it is safe to re-run.
--
-- >>> If your GMAO database is not called GMAO_NGES, replace GMAO_NGES below
-- >>> (find & replace - it appears in the lines that read FROM it).
-- Nothing in the original database is changed or deleted by this script.

USE GMAO_APP;
GO

IF OBJECT_ID('GMAO_NGES.dbo.app_pending_request') IS NOT NULL
BEGIN
    SET IDENTITY_INSERT dbo.app_pending_request ON;
    INSERT INTO dbo.app_pending_request (id, kind, id_requester, payload, status, id_result, created_at, resolved_at, resolved_by, reason)
    SELECT s.id, s.kind, s.id_requester, s.payload, s.status, s.id_result, s.created_at, s.resolved_at, s.resolved_by, s.reason
    FROM GMAO_NGES.dbo.app_pending_request s
    WHERE NOT EXISTS (SELECT 1 FROM dbo.app_pending_request d WHERE d.id = s.id);
    SET IDENTITY_INSERT dbo.app_pending_request OFF;
END;
GO

IF OBJECT_ID('GMAO_NGES.dbo.app_device_token') IS NOT NULL
BEGIN
    SET IDENTITY_INSERT dbo.app_device_token ON;
    INSERT INTO dbo.app_device_token (id, id_user, token, platform, created_at)
    SELECT s.id, s.id_user, s.token, s.platform, s.created_at
    FROM GMAO_NGES.dbo.app_device_token s
    WHERE NOT EXISTS (SELECT 1 FROM dbo.app_device_token d WHERE d.id = s.id OR d.token = s.token);
    SET IDENTITY_INSERT dbo.app_device_token OFF;
END;
GO

IF OBJECT_ID('GMAO_NGES.dbo.app_notification_log') IS NOT NULL
BEGIN
    SET IDENTITY_INSERT dbo.app_notification_log ON;
    INSERT INTO dbo.app_notification_log (id, id_user, type, id_ref, message, created_at, read_at)
    SELECT s.id, s.id_user, s.type, s.id_ref, s.message, s.created_at, s.read_at
    FROM GMAO_NGES.dbo.app_notification_log s
    WHERE NOT EXISTS (SELECT 1 FROM dbo.app_notification_log d WHERE d.id = s.id);
    SET IDENTITY_INSERT dbo.app_notification_log OFF;
END;
GO

-- Quick check: compare the two counts per table (they should match).
IF OBJECT_ID('GMAO_NGES.dbo.app_pending_request') IS NOT NULL
   AND OBJECT_ID('GMAO_NGES.dbo.app_device_token') IS NOT NULL
   AND OBJECT_ID('GMAO_NGES.dbo.app_notification_log') IS NOT NULL
    SELECT 'app_pending_request' AS tbl,
           (SELECT COUNT(*) FROM GMAO_NGES.dbo.app_pending_request) AS in_original,
           (SELECT COUNT(*) FROM dbo.app_pending_request) AS in_new
    UNION ALL
    SELECT 'app_device_token',
           (SELECT COUNT(*) FROM GMAO_NGES.dbo.app_device_token),
           (SELECT COUNT(*) FROM dbo.app_device_token)
    UNION ALL
    SELECT 'app_notification_log',
           (SELECT COUNT(*) FROM GMAO_NGES.dbo.app_notification_log),
           (SELECT COUNT(*) FROM dbo.app_notification_log);
GO
