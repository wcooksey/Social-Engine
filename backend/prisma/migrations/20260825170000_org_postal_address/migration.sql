-- CAN-SPAM requires a physical mailing address in the footer of commercial mail,
-- and its absence is read as a spam signal. It previously existed only on
-- playbook identities, with no input field on any surface — so an org without a
-- configured persona had no way to comply at all.
ALTER TABLE "Organization" ADD COLUMN     "postalAddress" TEXT;
