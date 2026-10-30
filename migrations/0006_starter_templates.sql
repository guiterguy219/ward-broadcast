-- Starter templates. Bodies leave out the group prefix and "Reply STOP" footer (added at send time).
-- INSERT OR IGNORE so edits made later through Claude are never overwritten.
INSERT OR IGNORE INTO templates (slug, name, body, default_groups, variables) VALUES
  ('lesson-reminder', 'Lesson reminder',
   'Sunday {{sunday}} lesson: "{{topic}}." {{extra}}',
   '["eq"]',
   '{"topic":{"required":true,"description":"Talk or lesson title"},"extra":{"default":"","description":"Optional short note, e.g. Read ahead if you can."}}'),
  ('help-needed', 'Help needed',
   '{{who}} could use help {{what}} {{when}}. {{details}}',
   '["eq"]',
   '{"who":{"default":"A ward family","description":"Who needs help; get their OK before naming them"},"what":{"required":true,"description":"e.g. loading a moving truck"},"when":{"required":true,"description":"e.g. Saturday at 9 am"},"details":{"default":"","description":"Where to show up or who to contact"}}'),
  ('activity', 'Activity',
   '{{what}} is {{when}} at {{where}}. {{details}}',
   '["eq"]',
   '{"what":{"required":true},"when":{"required":true,"description":"e.g. Thursday at 7 pm"},"where":{"required":true},"details":{"default":""}}'),
  ('ministering-interviews', 'Ministering interviews',
   'Ministering interviews are this month. Watch for a message from the presidency to set a time.',
   '["eq"]',
   '{}');
