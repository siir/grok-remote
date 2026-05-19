// Implements session/request_permission. With --always-approve we should rarely
// see these, but answer correctly when we do.

export function createPermissionHost() {
  return {
    async requestPermission(_params) {
      return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
    },
  };
}
