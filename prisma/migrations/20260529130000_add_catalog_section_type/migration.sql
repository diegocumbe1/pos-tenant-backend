-- Allow the retail-vertical 'catalog' section type on public site sections.
ALTER TABLE "public_site_sections"
    DROP CONSTRAINT "public_site_sections_type_check";

ALTER TABLE "public_site_sections"
    ADD CONSTRAINT "public_site_sections_type_check"
    CHECK ("type" IN (
        'hero',
        'trust_bar',
        'services',
        'catalog',
        'gallery',
        'instagram',
        'booking_cta',
        'booking_modal',
        'contact'
    ));
