// mupot-project-office — Worker entry. The Durable Object class is the whole point; the default handler
// answers nothing, so the Worker has no public surface of its own (the main Worker reaches the DO by binding).

export { ProjectOffice } from './project-office'

export default {
  fetch(): Response {
    return Response.json({ error: 'not_found' }, { status: 404 })
  },
} satisfies ExportedHandler
